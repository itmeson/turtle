/**
 * Getting files out of the editor — SPEC.md sections 9 and 11.
 *
 * Two routes, because browsers differ:
 *   - Download: works everywhere, lands in the Downloads folder.
 *   - Save to file: Chrome and Edge only, but writes straight to a folder the
 *     student picks -- a OneDrive- or Drive-synced one, say -- and remembers it,
 *     so later saves are one click to the same file.
 *
 * Feature-detect and hide what is unavailable rather than offering a button
 * that does nothing.
 */

export const canSaveToFile = typeof window !== 'undefined'
  && typeof window.showSaveFilePicker === 'function';

/** A filename that will survive every operating system. */
export function slugify(name, fallback = 'turtle-program') {
  const slug = String(name ?? '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** @param {Blob} blob @param {string} filename */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/**
 * Save-to-disk with a picker, remembering the chosen file for the session.
 *
 * The handle is kept in memory rather than IndexedDB: a stored handle needs a
 * fresh permission prompt on every page load, which is more friction than the
 * feature saves. Within a session, the second save onwards is one click.
 */
let retainedHandle = null;
let retainedName = null;

export function retainedFileName() {
  return retainedName;
}

export function forgetRetainedFile() {
  retainedHandle = null;
  retainedName = null;
}

/**
 * @param {string} text
 * @param {string} suggestedName
 * @param {boolean} [askAgain] force the picker even if a file is remembered
 * @returns {Promise<{saved: boolean, name?: string, reason?: string}>}
 */
export async function saveToFile(text, suggestedName, askAgain = false) {
  if (!canSaveToFile) return { saved: false, reason: 'unsupported' };

  try {
    if (!retainedHandle || askAgain) {
      retainedHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'Python program',
          accept: { 'text/x-python': ['.py'] },
        }],
      });
      retainedName = retainedHandle.name;
    }

    const writable = await retainedHandle.createWritable();
    await writable.write(text);
    await writable.close();
    return { saved: true, name: retainedName };
  } catch (err) {
    // AbortError just means the student closed the picker; that is not a
    // failure and should not be reported as one.
    if (err && err.name === 'AbortError') return { saved: false, reason: 'cancelled' };
    forgetRetainedFile();
    return { saved: false, reason: err?.message ?? 'unknown' };
  }
}
