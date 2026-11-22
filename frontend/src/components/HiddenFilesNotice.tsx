import { useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'

export interface HiddenFiles {
  count: number
  roots: Record<string, number>
  samples: string[]
}

// The command to run on the machine that holds the files: it lists every
// "._" file under the folder first, deletes nothing until the user types yes.
// The folder goes in as an argument, single-quoted, so no path can run as code.
function cleanupCommand(dir: string): string {
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`
  return (
    `sh -c 'DIR="$1"; LIST=/tmp/dot-underscore-files.txt; find "$DIR" -type f -name "._*" > "$LIST"; cat "$LIST"; echo; ` +
    `echo "$(wc -l < "$LIST") file(s) listed above will be deleted."; ` +
    `printf "Type yes to delete them, anything else cancels: "; read A; ` +
    `if [ "$A" = yes ]; then while IFS= read -r F; do rm -f -- "$F"; done < "$LIST"; echo Done; else echo Cancelled; fi' sh ${quoted}`
  )
}

// Shown at the bottom of the Duplicates page when a scan came across macOS
// "._name" files. They are never counted as duplicates, but they clutter the
// library, and Sonarr/Radarr can't delete them (they never index them) — so
// the clean-up is a command to run on the file machine, with a look first.
export default function HiddenFilesNotice({ serviceName, junk }: { serviceName: string; junk: HiddenFiles }) {
  const roots = Object.entries(junk.roots)
  const [dirs, setDirs] = useState<Record<string, string>>(() => Object.fromEntries(roots.map(([r]) => [r, r])))
  const [copied, setCopied] = useState('')

  async function copy(root: string) {
    if (await copyToClipboard(cleanupCommand(dirs[root] ?? root))) {
      setCopied(root)
      setTimeout(() => setCopied(''), 2000)
    }
  }

  return (
    <section className="mt-6 bg-slate-925 border border-slate-800 rounded-xl p-4">
      <h3 className="font-medium text-slate-100">
        macOS "._" files found in {serviceName} ({junk.count.toLocaleString()})
      </h3>
      <p className="mt-1 text-xs text-slate-400">
        A Mac that copies to a network share leaves a hidden <code>._name</code> metadata file beside each real file. They
        aren't needed and aren't counted as duplicates, but they clutter the library, and {serviceName} can't delete
        them. To remove them, log in to the machine that holds the files over SSH and run the command below. It{' '}
        <b className="text-slate-100">lists every file it would delete first</b> and deletes nothing until you type{' '}
        <code>yes</code>, so check the list before you answer.
      </p>

      {junk.samples.length > 0 && (
        <details className="mt-2 text-xs text-slate-400">
          <summary className="cursor-pointer">Examples ({Math.min(junk.samples.length, junk.count)} of {junk.count.toLocaleString()})</summary>
          <ul className="mt-1 space-y-0.5 break-all">
            {junk.samples.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </details>
      )}

      <div className="mt-3 space-y-4">
        {roots.map(([root, n]) => (
          <div key={root}>
            <label className="block text-sm text-slate-400 mb-1">
              Folder on the file machine for <span className="text-slate-100">{root}</span> ({n.toLocaleString()} file{n === 1 ? '' : 's'})
              <span className="block text-xs text-slate-400">
                {serviceName} calls it {root}; the machine may name it differently, so change this to the real path.
              </span>
            </label>
            <input
              className="input font-mono max-w-xl"
              value={dirs[root] ?? root}
              onChange={(e) => setDirs((d) => ({ ...d, [root]: e.target.value }))}
            />
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs text-slate-100">
              {cleanupCommand(dirs[root] ?? root)}
            </pre>
            <button onClick={() => copy(root)} className="btn-secondary mt-2">
              {copied === root ? 'Copied' : 'Copy command'}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
