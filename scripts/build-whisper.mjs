#!/usr/bin/env node
/**
 * Builds whisper-cli into resources/bin on any computer.
 *
 * On a Mac this runs build-whisper.sh, unchanged: Metal, embedded shaders,
 * for the oldest macOS the app opens on.
 *
 * On Windows it builds whisper-cli.exe with Visual Studio for the CPU, with
 * AVX2 (Intel and AMD processors from about 2013 on), and statically linked
 * against the C runtime with OpenMP off, so it needs no DLL beside it. Its
 * manifest asks Windows for UTF-8 (Windows 10 1903 and later), so paths and
 * names in any script reach it whole: whisper-cli reads its arguments in the
 * system's code page otherwise, and a model under C:\Users\Łukasz would not
 * open on an English Windows.
 *
 * On Linux it builds the same CPU whisper-cli, for development only.
 *
 *   node scripts/build-whisper.mjs
 *
 * WHISPER_REF picks the whisper.cpp tag (build-whisper.sh's own by default),
 * and WHISPER_WORK where it is cloned and built (.build/whisper.cpp).
 */
import { execFileSync, spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { availableParallelism } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform === 'darwin') {
  execFileSync(join(root, 'scripts', 'build-whisper.sh'), { stdio: 'inherit' })
  process.exit(0)
}

const windows = process.platform === 'win32'
/** The tag build-whisper.sh builds, so the Mac and Windows transcribe with the same whisper. */
const shRef = /REF="\$\{WHISPER_REF:-([^}]+)\}"/.exec(readFileSync(join(root, 'scripts', 'build-whisper.sh'), 'utf8'))
const ref = process.env.WHISPER_REF || shRef?.[1]
if (!ref) throw new Error('build-whisper.sh names no whisper.cpp tag (REF="${WHISPER_REF:-...}")')
const work = process.env.WHISPER_WORK || join(root, '.build', 'whisper.cpp')
const build = join(work, windows ? 'build-windows' : 'build-cpu')
const out = join(root, 'resources', 'bin')
const exe = windows ? 'whisper-cli.exe' : 'whisper-cli'

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
}

mkdirSync(out, { recursive: true })
if (!existsSync(join(work, '.git'))) {
  console.log(`Cloning whisper.cpp ${ref}`)
  run('git', ['clone', '--depth', '1', '--branch', ref, 'https://github.com/ggml-org/whisper.cpp', work])
}

const configure = [
  '-S',
  work,
  '-B',
  build,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  // The CPU in every PC from about 2013 on: AVX2, FMA and F16C (implied by AVX2 under MSVC).
  '-DGGML_NATIVE=OFF',
  '-DGGML_SSE42=ON',
  '-DGGML_AVX=ON',
  '-DGGML_AVX2=ON',
  '-DGGML_BMI2=ON',
  // OpenMP would bring its own DLL (vcomp140.dll); ggml's own threads do the same work.
  '-DGGML_OPENMP=OFF',
  '-DGGML_CCACHE=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_SDL2=OFF'
]
if (windows) {
  configure.push(
    '-A',
    'x64',
    // The C runtime inside the program, not in vcruntime140.dll beside it.
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
  )
} else {
  configure.push('-DGGML_FMA=ON', '-DGGML_F16C=ON')
}
run('cmake', configure)
run('cmake', [
  '--build',
  build,
  '--config',
  'Release',
  '--target',
  'whisper-cli',
  '--parallel',
  String(availableParallelism())
])

// Visual Studio puts each configuration in its own folder; other generators do not.
const built = [join(build, 'bin', 'Release', exe), join(build, 'bin', exe)].find((p) => existsSync(p))
if (!built) throw new Error(`whisper-cli was not built: nothing at ${join(build, 'bin')}`)
const dest = join(out, exe)
copyFileSync(built, dest)

if (windows) embedUtf8Manifest(dest)

// It runs, and says what it can do.
const help = spawnSync(dest, ['-h'], { encoding: 'utf8' })
if (help.status !== 0) {
  throw new Error(`${dest} -h exited with ${help.status}: ${help.stderr || help.stdout || help.error}`)
}
console.log(`built ${dest} (whisper.cpp ${ref}${windows ? ', CPU with AVX2, static' : ', CPU'})`)

/**
 * Asks Windows for UTF-8 as this program's code page, through its manifest
 * (mt.exe, from the Windows SDK). Without one it still runs, but a path or
 * a name outside the system's code page reaches it as question marks.
 */
function embedUtf8Manifest(file) {
  const kits = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = existsSync(kits)
    ? readdirSync(kits)
        .filter((v) => /^10\./.test(v) && existsSync(join(kits, v, 'x64', 'mt.exe')))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : []
  const mt = versions.length ? join(kits, versions[versions.length - 1], 'x64', 'mt.exe') : null
  if (!mt) {
    console.log('::warning::mt.exe was not found, so whisper-cli.exe reads its arguments in the system code page')
    return
  }
  const manifest = join(build, 'whisper-cli.utf8.manifest')
  writeFileSync(
    manifest,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
`
  )
  run(mt, ['-nologo', '-manifest', manifest, `-outputresource:${file};#1`])
  console.log(`whisper-cli.exe asks for UTF-8 (${mt})`)
}
