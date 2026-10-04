// @vitest-environment happy-dom
/**
 * Tests for the drag & drop dataset path (issue #5).
 *
 * The entries API is non-standard and never implemented in test environments, so
 * the fake below mimics it closely enough to exercise the recursive walk: in
 * particular the 100-entry batching rule, which is the easy thing to get wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDropzone, filesFromDrop } from '../src/ui/dropzone';
import { localSource } from '../src/data/loader';

/** In-memory File stand-in; happy-dom File has no backing bytes we control. */
function fakeFile(name: string, size = 64): File {
  return { name, size } as unknown as File;
}

interface FakeEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (f: File) => void) => void;
  createReader?: () => {
    readEntries: (ok: (e: FakeEntry[]) => void) => void;
  };
}

function fileEntry(name: string, size = 64): FakeEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok) => ok(fakeFile(name, size)),
  };
}

/**
 * Directory that yields `children` in batches of `batchSize`, matching the real
 * reader's cap.
 */
function dirEntry(name: string, children: FakeEntry[], batchSize = 100): FakeEntry {
  let offset = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (ok) => {
        const batch = children.slice(offset, offset + batchSize);
        offset += batch.length;
        ok(batch);
      },
    }),
  };
}

function dataTransfer(entries: FakeEntry[] | null, files: File[] = []): DataTransfer {
  const items = (entries ?? []).map((entry) => {
    let handed = false;
    return {
      kind: 'file',
      // The API hands out each entry exactly once per drop.
      webkitGetAsEntry: () => {
        if (handed) return null;
        handed = true;
        return entry;
      },
    };
  });
  return { items, files } as unknown as DataTransfer;
}

describe('filesFromDrop', () => {
  it('keeps the day directory from the dropped path', async () => {
    const transfer = dataTransfer([
      dirEntry('player_data', [
        dirEntry('February_10', [fileEntry('uuid_1.nakama-0'), fileEntry('42_1.nakama-1')]),
        dirEntry('February_11', [fileEntry('uuid_2.nakama-0')]),
      ]),
    ]);

    const files = await filesFromDrop(transfer);

    expect(files.map((f) => f.path)).toEqual([
      'player_data/February_10/uuid_1.nakama-0',
      'player_data/February_10/42_1.nakama-1',
      'player_data/February_11/uuid_2.nakama-0',
    ]);
  });

  it('ignores files that are not parquet telemetry', async () => {
    const transfer = dataTransfer([
      dirEntry('February_10', [fileEntry('uuid_1.nakama-0'), fileEntry('notes.md')]),
    ]);

    expect((await filesFromDrop(transfer)).map((f) => f.path)).toEqual([
      'February_10/uuid_1.nakama-0',
    ]);
  });

  it('drains the reader past its 100-entry batch limit', async () => {
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`u${i}.nakama-0`));
    const transfer = dataTransfer([dirEntry('February_10', many)]);

    expect(await filesFromDrop(transfer)).toHaveLength(250);
  });

  it('recurses more than one level deep', async () => {
    const transfer = dataTransfer([
      dirEntry('root', [dirEntry('mid', [dirEntry('February_10', [fileEntry('u1.nakama-0')])])]),
    ]);

    expect((await filesFromDrop(transfer))[0]?.path).toBe('root/mid/February_10/u1.nakama-0');
  });

  it('rejects a drop with no telemetry files', async () => {
    await expect(filesFromDrop(dataTransfer([fileEntry('notes.md')]))).rejects.toThrow(
      /No .nakama-/,
    );
  });

  it('rejects loose files when the entries API is unavailable', async () => {
    // Older browsers give only File.name, from which no day can be recovered.
    const transfer = dataTransfer(null, [fakeFile('uuid_1.nakama-0')]);
    await expect(filesFromDrop(transfer)).rejects.toThrow(/cannot read a dropped folder/);
  });
});

describe('localSource', () => {
  const files = [
    { file: fakeFile('uuid_1.nakama-0', 100), path: 'player_data/February_10/uuid_1.nakama-0' },
    { file: fakeFile('7_1.nakama-0', 200), path: 'player_data/February_11/7_1.nakama-0' },
  ];

  it('derives the day from the parent directory', () => {
    expect(localSource(files).days).toEqual(['February_10', 'February_11']);
  });

  it('keeps the byte size and bot hint of the manifest shape', () => {
    const source = localSource(files);
    expect(source.files.map((f) => f.s)).toEqual([100, 200]);
    expect(source.files.map((f) => f.b)).toEqual([0, 1]);
    expect(source.files.map((f) => f.d)).toEqual(['February_10', 'February_11']);
  });

  it('is never degraded, because a local read is always whole', () => {
    expect(localSource(files).degraded).toBe(false);
  });

  it('serves slices of the dropped file without any Range request', async () => {
    const slice = vi.fn((start: number, end: number) => ({
      start,
      end,
      arrayBuffer: async () => new ArrayBuffer(Math.max(0, end - start)),
    }));
    const file = { name: 'u1.nakama-0', size: 128, slice } as unknown as File;
    const source = localSource([{ file, path: 'February_10/u1.nakama-0' }]);

    const buffer = source.open(source.files[0]!);
    expect(buffer.byteLength).toBe(128);
    const sliceResult = await buffer.slice(8, 32);

    expect(slice).toHaveBeenCalledWith(8, 32);
    expect((sliceResult as ArrayBuffer).byteLength).toBe(24);
  });

  it('files a dropped tree with no day directory under a single day', () => {
    const source = localSource([{ file: fakeFile('uuid_1.nakama-0'), path: 'uuid_1.nakama-0' }]);
    expect(source.days).toEqual(['dropped']);
  });
});

describe('enableDropzone', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  function drop(target: HTMLElement, transfer: DataTransfer): void {
    target.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }

  it('shows the prompt on drag and hands over the files on drop', async () => {
    const target = document.createElement('div');
    document.body.append(target);

    const received: string[] = [];
    teardown = enableDropzone(target, {
      onFiles: (dropped) => received.push(...dropped.map((f) => f.path)),
      onError: () => {},
    });

    const hint = document.querySelector('.dropzone')!;
    expect(hint.classList.contains('is-active')).toBe(false);

    target.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    expect(hint.classList.contains('is-active')).toBe(true);

    drop(target, dataTransfer([dirEntry('February_10', [fileEntry('u1.nakama-0')])]));
    await vi.waitFor(() => expect(received).toEqual(['February_10/u1.nakama-0']));
    expect(hint.classList.contains('is-active')).toBe(false);
  });

  it('stays visible while the pointer moves between children', () => {
    const target = document.createElement('div');
    document.body.append(target);
    teardown = enableDropzone(target, { onFiles: () => {}, onError: () => {} });

    const hint = document.querySelector('.dropzone')!;
    target.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));

    expect(hint.classList.contains('is-active')).toBe(true);
  });

  it('reports a rejected drop without throwing', async () => {
    const target = document.createElement('div');
    document.body.append(target);

    const errors: string[] = [];
    teardown = enableDropzone(target, { onFiles: () => {}, onError: (m) => errors.push(m) });

    drop(target, dataTransfer([fileEntry('notes.md')]));
    await vi.waitFor(() => expect(errors[0]).toMatch(/No .nakama-/));
  });

  it('removes its overlay and listeners on teardown', () => {
    const target = document.createElement('div');
    document.body.append(target);

    const dispose = enableDropzone(target, { onFiles: () => {}, onError: () => {} });
    expect(document.querySelector('.dropzone')).not.toBeNull();

    dispose();
    expect(document.querySelector('.dropzone')).toBeNull();
  });
});