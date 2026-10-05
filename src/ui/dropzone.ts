/**
 * Drag and drop loading of a local parquet dataset (issue #5).
 *
 * The interesting problem is not reading the bytes, it is preserving the folder
 * layout. `File.name` is just `<userId>_<matchId>.nakama-0`, so the day a file
 * belongs to only exists in its path. `DataTransferItem.webkitGetAsEntry()` is the
 * only way to see that for a dropped directory, hence the manual walk below
 * instead of `DataTransfer.files`.
 */
import type { DroppedFile } from '../data/loader';
import { el } from './dom';

/** Telemetry files are `<userId>_<matchId>.nakama-N`. */
const PARQUET_FILE = /\.nakama-\d+$/i;

/**
 * Minimal structural types for the non-standard entries API.
 *
 * `webkitGetAsEntry` is WebKit/Blink only and its `FileSystemFileEntry` type is
 * absent from lib.dom, so the shapes are declared here rather than leaning on
 * `any`.
 */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface FileEntry extends Entry {
  isFile: true;
  file(ok: (file: File) => void, err: (error: unknown) => void): void;
}

interface DirectoryEntry extends Entry {
  isDirectory: true;
  createReader(): DirectoryReader;
}

interface DirectoryReader {
  readEntries(ok: (entries: Entry[]) => void, err: (error: unknown) => void): void;
}

function readFile(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: DirectoryReader): Promise<Entry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Collects every parquet file under a dropped entry, recursively.
 *
 * `readEntries` yields at most 100 children per call, so the reader must be
 * drained until it returns an empty batch or a large directory tree is silently
 * truncated.
 */
async function walk(entry: Entry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    if (!PARQUET_FILE.test(entry.name)) return;
    try {
      out.push({ file: await readFile(entry as FileEntry), path: `${prefix}${entry.name}` });
    } catch {
      // An unreadable file is skipped rather than failing the whole drop.
    }
    return;
  }

  if (!entry.isDirectory) return;

  const directory = entry as DirectoryEntry;
  const reader = directory.createReader();
  const childPrefix = `${prefix}${entry.name}/`;

  for (;;) {
    let batch: Entry[];
    try {
      batch = await readBatch(reader);
    } catch {
      return;
    }
    if (batch.length === 0) return;
    for (const child of batch) {
      await walk(child, childPrefix, out);
    }
  }
}

/**
 * Extracts parquet files from a drop.
 *
 * @throws when the drop contains no parquet files, or only loose files with no
 * parent directory (from which no day can be recovered).
 */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const entries: Entry[] = [];

  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      // Non-standard but universally implemented for this purpose.
      const entry = (item as DataTransferItem & {
        webkitGetAsEntry?: () => Entry | null;
      }).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    for (const entry of entries) {
      await walk(entry, '', out);
    }
  } else {
    // Fallback for browsers without the entries API: only File.name is available,
    // so no day directory can be recovered.
    const loose: DroppedFile[] = [];
    for (const file of Array.from(dataTransfer.files)) {
      if (PARQUET_FILE.test(file.name)) loose.push({ file, path: file.name });
    }
    if (loose.length > 0) {
      throw new Error(
        'This browser cannot read a dropped folder. Drop the folder that contains the ' +
          'day directories, or use a Chromium-based browser.',
      );
    }
  }

  if (out.length === 0) {
    throw new Error('No .nakama-* parquet files were found in that drop.');
  }

  return out;
}

export interface DropzoneOptions {
  /** Called with the dropped files, or with an error to display. */
  onFiles(files: DroppedFile[]): void;
  onError(message: string): void;
}

/**
 * Makes a target accept dropped dataset folders.
 *
 * Returns a teardown function. The drag counter is deliberate: `dragleave` also
 * fires when moving between the target's own children, which would otherwise
 * flicker the highlight off mid-drag.
 */
export function enableDropzone(target: HTMLElement, options: DropzoneOptions): () => void {
  const hint = el(
    'div',
    { class: 'dropzone' },
    el('div', { class: 'dropzone__card' },
      el('p', { class: 'dropzone__title' }, 'Drop a dataset folder'),
      el('p', { class: 'dropzone__meta' },
        'A folder of day directories containing .nakama-* parquet files. ' +
        'They are read locally; nothing is uploaded.'),
    ),
  );
  document.body.append(hint);

  let depth = 0;

  const show = (on: boolean): void => {
    hint.classList.toggle('is-active', on);
  };

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer) return;
    // Required, or the browser navigates to the dropped file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    depth++;
    show(true);
  };

  const onDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    depth = 0;
    show(false);

    const transfer = event.dataTransfer;
    if (!transfer) return;

    filesFromDrop(transfer).then(options.onFiles, (error: unknown) => {
      options.onError(error instanceof Error ? error.message : String(error));
    });
  };

  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);

  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragenter', onDragEnter);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
    hint.remove();
  };
}
