import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

// 构建 vision-ocr（本地屏幕记忆 OCR 助手，macOS Vision 侧车）：
// swiftc 编译通用二进制（arm64 + x86_64）到 build/vision-ocr/darwin-universal/。
// 源码在 native/vision-ocr/；产物随 extraResources 内置，产品运行时零网络安装。
// 非 macOS 平台静默跳过（本助手仅 macOS 需要）。

const desktopRoot = dirname(import.meta.dirname)
const source = join(desktopRoot, 'native', 'vision-ocr', 'main.swift')
const targetDirectory = join(desktopRoot, 'build', 'vision-ocr', 'darwin-universal')
const target = join(targetDirectory, 'vision-ocr')

if (process.platform !== 'darwin') {
  console.log('vision-ocr is macOS-only; skip prepare')
  process.exit(0)
}

async function sourceChanged() {
  try {
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)])
    return sourceStat.mtimeMs > targetStat.mtimeMs
  } catch {
    return true
  }
}

if (!(await sourceChanged())) {
  console.log(`vision-ocr up to date: ${target}`)
  process.exit(0)
}

await mkdir(targetDirectory, { recursive: true })
const arm64Build = join(targetDirectory, 'vision-ocr.arm64.tmp')
const x64Build = join(targetDirectory, 'vision-ocr.x86_64.tmp')
const minTarget = '13.0'
function compile(arch, output) {
  const result = spawnSync('swiftc', ['-O', '-target', `${arch}-apple-macosx${minTarget}`, '-o', output, source], {
    stdio: 'inherit',
  })
  return result.status === 0
}
if (!compile('arm64', arm64Build) || !compile('x86_64', x64Build)) {
  throw new Error('vision-ocr compile failed (需要 Xcode Command Line Tools: xcode-select --install)')
}
const lipo = spawnSync('lipo', ['-create', '-output', target, arm64Build, x64Build], { stdio: 'inherit' })
if (lipo.status !== 0) {
  throw new Error('vision-ocr lipo merge failed')
}
await rm(arm64Build, { force: true })
await rm(x64Build, { force: true })
await chmod(target, 0o755)

const version = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 15_000 })
const versionText = version.status === 0 ? (version.stdout || '').trim() : `exit ${String(version.status)}`
console.log(`Prepared vision-ocr: ${target} (${versionText}, universal)`)
