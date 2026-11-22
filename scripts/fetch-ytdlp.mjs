#!/usr/bin/env node
/**
 * Fetches yt-dlp into resources/bin on any computer, from its own releases,
 * and checks it against the checksum pinned here before it is kept.
 *
 * On a Mac this runs fetch-ytdlp.sh, unchanged. On Windows it fetches
 * yt-dlp.exe; on Linux, for development, yt-dlp_linux. The version is
 * fetch-ytdlp.sh's (or YTDLP_VERSION). For the version pinned below, the
 * file must match the SHA-256 written here; for any other, it must match
 * the SHA2-256SUMS published with that release, and the build says so,
 * since a sum fetched beside the file proves less than one kept here.
 *
 *   node scripts/fetch-ytdlp.mjs
 */
import { createHash } from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform === 'darwin') {
  execFileSync(join(root, 'scripts', 'fetch-ytdlp.sh'), { stdio: 'inherit' })
  process.exit(0)
}

/** SHA-256 of each release file, from that release's SHA2-256SUMS. */
const PINNED = {
  version: '2026.08.19',
  sha256: {
    'yt-dlp.exe': '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
    'yt-dlp_linux': '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a'
  }
}

const shVersion = /VERSION="\$\{YTDLP_VERSION:-([^}]+)\}"/.exec(
  readFileSync(join(root, 'scripts', 'fetch-ytdlp.sh'), 'utf8')
)?.[1]
const version = process.env.YTDLP_VERSION || shVersion
if (!version) throw new Error('fetch-ytdlp.sh names no yt-dlp version (VERSION="${YTDLP_VERSION:-...}")')
const windows = process.platform === 'win32'
const asset = windows ? 'yt-dlp.exe' : 'yt-dlp_linux'
const dest = join(root, 'resources', 'bin', windows ? 'yt-dlp.exe' : 'yt-dlp')
const release = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`

function versionOf(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) throw err
      console.log(`retrying ${url}: ${err.message}`)
    }
  }
}

mkdirSync(dirname(dest), { recursive: true })
const have = existsSync(dest) ? versionOf(dest) : null
if (have === version) {
  console.log(`yt-dlp already present (${have})`)
  process.exit(0)
}

let expected = version === PINNED.version ? PINNED.sha256[asset] : null
if (!expected) {
  const sums = (await download(`${release}/SHA2-256SUMS`)).toString('utf8')
  expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!expected) throw new Error(`SHA2-256SUMS of yt-dlp ${version} has no ${asset}`)
  console.log(`::warning::yt-dlp ${version} is checked against the sum published beside it; pin it in scripts/fetch-ytdlp.mjs`)
}

const bytes = await download(`${release}/${asset}`)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== expected) {
  throw new Error(`${asset} ${version} has SHA-256 ${actual}, not ${expected}: it is not the file yt-dlp released`)
}
const partial = `${dest}.part`
writeFileSync(partial, bytes)
chmodSync(partial, 0o755)
renameSync(partial, dest)
console.log(`fetched yt-dlp ${versionOf(dest) ?? '(it did not start)'} (${asset}, SHA-256 ${actual})`)
if (!versionOf(dest)) process.exit(1)
