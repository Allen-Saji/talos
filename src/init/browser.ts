import open from 'open'
import { child } from '@/shared/logger'

const log = child({ module: 'init-browser' })

/**
 * Open a URL in the user's default browser. Best-effort — if it fails (no
 * display server, headless box, etc.) we log and let the caller fall back to
 * printing the URL for manual paste. Never throws.
 */
export async function openInBrowser(url: string): Promise<{ opened: boolean }> {
  try {
    await open(url)
    return { opened: true }
  } catch (err) {
    log.warn({ err, url }, 'failed to open browser — user will paste URL manually')
    return { opened: false }
  }
}
