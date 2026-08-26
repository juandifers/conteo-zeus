/**
 * Handing the file to the person.
 *
 * There is no backend and there is not going to be one at this stage: the app
 * generates bytes, the browser saves them, and somebody uploads them to Zeus
 * exactly as they do today. This is the whole of that step.
 *
 * A port rather than three lines inline, because "the bytes that reached the
 * disk are the bytes `generateAdjustment` produced" is the one property of
 * this file worth asserting, and asserting it means being able to catch them.
 */

export interface Downloader {
  /** Offer `bytes` to the person under `filename`. */
  save(filename: string, bytes: Uint8Array): void;
}

/**
 * The browser's own download, and the one detail that matters in it.
 *
 * The `Blob` is built from the `Uint8Array` directly. Handing it a string
 * instead would put the bytes through the platform's UTF-8 encoder on the way
 * in, and the file is CP850 (ZEUS_FORMAT.md §3): every `Ñ` in the catalogue
 * would arrive at Zeus as two bytes. `application/octet-stream` for the same
 * reason — there is no charset to declare, because these are not characters.
 */
export function browserDownload(): Downloader {
  return {
    save(filename, bytes) {
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      // Not immediately: Safari has been known to cancel a download whose
      // object URL is revoked in the same tick as the click.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}
