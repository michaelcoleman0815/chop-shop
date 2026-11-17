#!/usr/bin/env node
/**
 * Fails when a program or native module the Windows app ships needs a DLL
 * that a clean Windows may not have: Windows' twin of check-macos-min.sh.
 *
 * Each binary's imports are read from its PE header. Every DLL it loads at
 * start must be beside it, or part of Windows (in System32, and not the
 * Visual C++ runtime, which PCs have only when some program installed it).
 * A DLL loaded only when used (a delay-load) is listed, not required.
 *
 *   check-windows-binaries.mjs           what the app ships, before packaging
 *   check-windows-binaries.mjs <dir>...  every .exe, .dll and .node in them
 *                                        (a packaged app: release/win-unpacked)
 *
 * It reads the files anywhere, so it can be tried on a Mac or Linux; only on
 * Windows can it tell a system DLL by looking in System32.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')

/** The Visual C++ runtime: part of Windows only once some program installed it. */
const REDIST = /^(msvcp\d|vcruntime\d|vcomp\d|concrt\d|vccorlib\d|msvcr1\d|mfc\d|ucrtbased)/i

/** DLLs every Windows 10 and 11 has, for reading binaries on another system. */
const KNOWN = new Set(
  [
    'advapi32', 'avicap32', 'bcrypt', 'bcryptprimitives', 'cfgmgr32', 'comctl32', 'comdlg32', 'crypt32',
    'cryptbase', 'd2d1', 'd3d11', 'd3d12', 'd3d9', 'dbghelp', 'dcomp', 'dnsapi', 'dwmapi', 'dwrite', 'dxgi',
    'gdi32', 'hid', 'imm32', 'iphlpapi', 'kernel32', 'mf', 'mfplat', 'mfreadwrite', 'msimg32', 'msvcrt',
    'mswsock', 'ncrypt', 'netapi32', 'normaliz', 'ntdll', 'ole32', 'oleacc', 'oleaut32', 'opengl32',
    'powrprof', 'propsys', 'psapi', 'rpcrt4', 'secur32', 'setupapi', 'shcore', 'shell32', 'shlwapi',
    'uiautomationcore', 'urlmon', 'user32', 'userenv', 'usp10', 'uxtheme', 'version', 'winhttp', 'wininet',
    'winmm', 'winspool.drv', 'wldap32', 'ws2_32', 'wtsapi32'
  ].map((n) => (n.includes('.') ? n : `${n}.dll`))
)

/** The DLLs a PE file imports, and those it delay-loads, with its machine type. */
export function peImports(data) {
  if (data.length < 64 || data.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a Windows program')
  const pe = data.readUInt32LE(0x3c)
  if (data.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('no PE header')
  const machine = data.readUInt16LE(pe + 4)
  const sections = data.readUInt16LE(pe + 6)
  const optSize = data.readUInt16LE(pe + 20)
  const opt = pe + 24
  const dirs = opt + (data.readUInt16LE(opt) === 0x20b ? 112 : 96)
  const table = opt + optSize
  const map = Array.from({ length: sections }, (_, i) => {
    const s = table + 40 * i
    return {
      va: data.readUInt32LE(s + 12),
      size: Math.max(data.readUInt32LE(s + 8), data.readUInt32LE(s + 16)),
      raw: data.readUInt32LE(s + 20)
    }
  })
  const at = (rva) => {
    const s = map.find((m) => rva >= m.va && rva < m.va + m.size)
    if (!s) throw new Error(`address ${rva.toString(16)} is in no section`)
    return rva - s.va + s.raw
  }
  const name = (rva) => {
    const o = at(rva)
    return data.toString('latin1', o, data.indexOf(0, o))
  }
  const list = (dir, step, nameAt) => {
    const rva = data.readUInt32LE(dirs + 8 * dir)
    const out = []
    if (!rva) return out
    for (let o = at(rva); ; o += step) {
      const n = data.readUInt32LE(o + nameAt)
      if (!n) break
      out.push(name(n))
    }
    return out
  }
  return { machine, imports: list(1, 20, 12), delayed: list(13, 32, 4) }
}

function isSystem(dll) {
  const lower = dll.toLowerCase()
  if (/^(api|ext)-ms-win-/.test(lower)) return true
  if (REDIST.test(lower)) return false
  if (windows) return existsSync(join(system32, dll))
  return KNOWN.has(lower)
}

/** Everything a packaged Windows app or a folder of helpers holds that Windows loads. */
function binariesIn(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...binariesIn(path))
    else if (/\.(exe|dll|node)$/i.test(entry.name)) found.push(path)
  }
  return found
}

/** What the Windows app ships, as it sits in this checkout before packaging. */
function shipped() {
  const nm = join(root, 'node_modules')
  const files = []
  const add = (dir, test) => {
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (test.test(f)) files.push(join(dir, f))
  }
  add(join(root, 'resources', 'bin'), /\.exe$/i)
  add(join(nm, 'ffmpeg-static'), /\.exe$/i)
  add(join(nm, '@ffprobe-installer', 'win32-x64'), /\.exe$/i)
  add(join(nm, '@napi-rs', 'canvas-win32-x64-msvc'), /\.node$/i)
  add(join(nm, 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64'), /\.(node|dll)$/i)
  return files
}

const MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' }

const dirs = process.argv.slice(2)
const files = dirs.length ? dirs.flatMap((d) => binariesIn(d)) : shipped()
if (files.length === 0) {
  console.log('::error::found nothing to check')
  process.exit(1)
}

let fail = false
for (const file of files.sort()) {
  let info
  try {
    info = peImports(readFileSync(file))
  } catch (err) {
    console.log(`::error::${file}: ${err.message}`)
    fail = true
    continue
  }
  const beside = new Set(readdirSync(dirname(file)).map((f) => f.toLowerCase()))
  const missing = info.imports.filter((d) => !beside.has(d.toLowerCase()) && !isSystem(d))
  const arch = MACHINES[info.machine] ?? `machine 0x${info.machine.toString(16)}`
  const kb = Math.round(statSync(file).size / 1024)
  const own = info.imports.filter((d) => beside.has(d.toLowerCase()))
  const line = `${basename(file)} (${arch}, ${kb} KB)${own.length ? `, with ${own.join(', ')} beside it` : ''}${
    info.delayed.length ? `; loads when used: ${info.delayed.join(', ')}` : ''
  }`
  if (arch !== 'x64') {
    console.log(`::error::${file} is ${arch}, not x64`)
    fail = true
  } else if (missing.length) {
    const level = windows ? 'error' : 'warning'
    console.log(`::${level}::${file} needs ${missing.join(', ')}, which a clean Windows does not have`)
    if (windows) fail = true
  } else {
    console.log(`ok   ${line}`)
  }
}
process.exit(fail ? 1 : 0)
