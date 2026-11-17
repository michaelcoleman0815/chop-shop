#!/usr/bin/env node
/**
 * Puts the Microsoft C++ runtime beside onnxruntime-node's Windows binary,
 * before the app is packaged.
 *
 * onnxruntime's binding and DLL are built against the Visual C++ runtime
 * (msvcp140.dll, vcruntime140.dll and their kin), which Windows itself does
 * not have: it comes with the Visual C++ Redistributable, which many PCs
 * have from some other program and some do not. Without it the face finder
 * cannot load there. Windows looks beside a native module for the DLLs it
 * needs, so a copy of the runtime there makes the app whole; Microsoft lets
 * these files be shipped with an app this way.
 *
 * They come from the newest Visual Studio's redistributable folder (as CI
 * has), or else from System32. Windows only; elsewhere this does nothing.
 *
 *   node scripts/bundle-msvc-runtime.mjs
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'win32') {
  console.log('the Microsoft C++ runtime is bundled on Windows only')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ort = join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')
if (!existsSync(ort)) throw new Error(`onnxruntime-node has no Windows x64 binary at ${ort}`)

const numeric = (a, b) => a.localeCompare(b, undefined, { numeric: true })

/** The newest Visual Studio's x64 C++ runtime folder, or null. */
function redistFolder() {
  const vswhere = join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  )
  if (!existsSync(vswhere)) return null
  const installs = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], {
    encoding: 'utf8'
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const vs of installs) {
    const msvc = join(vs, 'VC', 'Redist', 'MSVC')
    if (!existsSync(msvc)) continue
    for (const version of readdirSync(msvc).filter((v) => /^\d/.test(v)).sort(numeric).reverse()) {
      const x64 = join(msvc, version, 'x64')
      if (!existsSync(x64)) continue
      const crt = readdirSync(x64)
        .filter((d) => /^Microsoft\.VC\d+\.CRT$/.test(d))
        .sort(numeric)
        .pop()
      if (crt) return join(x64, crt)
    }
  }
  return null
}

const from = redistFolder() ?? join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const wanted = readdirSync(from).filter((f) =>
  /^(msvcp140(_1|_2|_atomic_wait|_codecvt_ids)?|vcruntime140(_1)?)\.dll$/i.test(f)
)
for (const need of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
  if (!wanted.some((f) => f.toLowerCase() === need)) throw new Error(`${need} is not in ${from}`)
}
for (const f of wanted) copyFileSync(join(from, f), join(ort, f))
console.log(`copied ${wanted.join(', ')} from ${from} to ${ort}`)
