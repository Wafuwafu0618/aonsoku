import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { getWrapperConfig, isWrapperAvailable } from './wrapper-client'

const LOG_TAG = '[AppleMusicWrapperRuntime]'
const IMAGE_NAME = 'aonsoku-wrapper'
const SERVICE_CONTAINER_NAME = 'aonsoku-wrapper'
const LOGIN_CONTAINER_NAME = 'aonsoku-wrapper-login'
const DEFAULT_LOG_TAIL = 200

export interface AppleMusicWrapperCommandResult {
  ok: boolean
  message: string
  stderr?: string
}

export interface AppleMusicWrapperContainerState {
  state: 'missing' | 'running' | 'stopped'
  statusText: string
}

export interface AppleMusicWrapperRuntimeStatus {
  dockerAvailable: boolean
  wrapperDirPath: string | null
  dataDirPath: string | null
  musicTokenPath: string | null
  imageExists: boolean
  service: AppleMusicWrapperContainerState
  login: AppleMusicWrapperContainerState
  accountReachable: boolean
  hasMusicToken: boolean
}

interface RunCommandResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  errorMessage?: string
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveWrapperDirPath(): Promise<string | null> {
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const basePaths = [cwd, appPath, process.resourcesPath]
  const candidates = basePaths.flatMap((basePath) => [
    join(basePath, 'tools', 'Wrapper'),
    join(basePath, 'tools', 'wrapper-main'),
  ])

  for (const candidate of candidates) {
    const hasDockerfile = await pathExists(join(candidate, 'Dockerfile'))
    const hasWrapperBinary = await pathExists(join(candidate, 'wrapper'))
    if (hasDockerfile && hasWrapperBinary) {
      return candidate
    }
  }

  return null
}

function getDataDirPath(wrapperDirPath: string): string {
  return join(wrapperDirPath, 'rootfs', 'data')
}

function getMusicTokenPath(wrapperDirPath: string): string {
  return join(
    wrapperDirPath,
    'rootfs',
    'data',
    'data',
    'com.apple.android.music',
    'files',
    'MUSIC_TOKEN',
  )
}

function getTwoFactorCodePath(wrapperDirPath: string): string {
  return join(
    wrapperDirPath,
    'rootfs',
    'data',
    'data',
    'com.apple.android.music',
    'files',
    '2fa.txt',
  )
}

async function runDockerCommand(
  args: string[],
  options?: { cwd?: string },
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const processRef = spawn('docker', args, {
      cwd: options?.cwd,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    processRef.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    })
    processRef.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    })

    processRef.on('error', (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        errorMessage: error.message,
      })
    })

    processRef.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : -1
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

async function inspectContainerState(
  name: string,
): Promise<AppleMusicWrapperContainerState> {
  const result = await runDockerCommand([
    'ps',
    '-a',
    '--filter',
    `name=^/${name}$`,
    '--format',
    '{{.Status}}',
  ])

  if (!result.ok) {
    return {
      state: 'missing',
      statusText: result.errorMessage ?? result.stderr ?? 'unknown',
    }
  }

  const statusText = result.stdout.split('\n').map((line) => line.trim())[0] ?? ''
  if (statusText.length === 0) {
    return { state: 'missing', statusText: 'not-created' }
  }

  const normalized = statusText.toLowerCase()
  if (normalized.startsWith('up ')) {
    return { state: 'running', statusText }
  }

  return { state: 'stopped', statusText }
}

async function isDockerAvailable(): Promise<boolean> {
  const result = await runDockerCommand(['version', '--format', '{{.Server.Version}}'])
  return result.ok
}

async function hasWrapperImage(): Promise<boolean> {
  const result = await runDockerCommand(['image', 'inspect', IMAGE_NAME])
  return result.ok
}

async function ensureWrapperDir(): Promise<string> {
  const wrapperDirPath = await resolveWrapperDirPath()
  if (!wrapperDirPath) {
    throw new Error(
      `${LOG_TAG} Wrapper directory not found. Expected tools/Wrapper or tools/wrapper-main with Dockerfile + wrapper binary.`,
    )
  }

  return wrapperDirPath
}

async function ensureDataDir(wrapperDirPath: string): Promise<string> {
  const dataDirPath = getDataDirPath(wrapperDirPath)
  await mkdir(dataDirPath, { recursive: true })
  return dataDirPath
}

async function cleanupContainer(name: string): Promise<void> {
  await runDockerCommand(['rm', '-f', name])
}

export async function getAppleMusicWrapperRuntimeStatus(): Promise<AppleMusicWrapperRuntimeStatus> {
  const dockerAvailable = await isDockerAvailable()
  const wrapperDirPath = await resolveWrapperDirPath()
  const dataDirPath = wrapperDirPath ? getDataDirPath(wrapperDirPath) : null
  const musicTokenPath = wrapperDirPath ? getMusicTokenPath(wrapperDirPath) : null
  const imageExists = dockerAvailable ? await hasWrapperImage() : false
  const service = dockerAvailable
    ? await inspectContainerState(SERVICE_CONTAINER_NAME)
    : { state: 'missing', statusText: 'docker-unavailable' }
  const login = dockerAvailable
    ? await inspectContainerState(LOGIN_CONTAINER_NAME)
    : { state: 'missing', statusText: 'docker-unavailable' }
  const accountReachable =
    dockerAvailable && service.state === 'running'
      ? await isWrapperAvailable()
      : false
  const hasMusicToken =
    typeof musicTokenPath === 'string' ? await pathExists(musicTokenPath) : false

  return {
    dockerAvailable,
    wrapperDirPath,
    dataDirPath,
    musicTokenPath,
    imageExists,
    service,
    login,
    accountReachable,
    hasMusicToken,
  }
}

export async function buildAppleMusicWrapperImage(): Promise<AppleMusicWrapperCommandResult> {
  const wrapperDirPath = await ensureWrapperDir()
  const result = await runDockerCommand(
    ['build', '--tag', IMAGE_NAME, '.'],
    { cwd: wrapperDirPath },
  )

  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? 'Failed to build wrapper image.',
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    message: 'Wrapper image build completed.',
  }
}

export async function startAppleMusicWrapperService(): Promise<AppleMusicWrapperCommandResult> {
  const wrapperDirPath = await ensureWrapperDir()
  const dataDirPath = await ensureDataDir(wrapperDirPath)
  const wrapperConfig = getWrapperConfig()

  await cleanupContainer(LOGIN_CONTAINER_NAME)
  await cleanupContainer(SERVICE_CONTAINER_NAME)

  const argsValue = `-H 0.0.0.0 -D ${wrapperConfig.decryptPort} -M ${wrapperConfig.m3u8Port} -A ${wrapperConfig.accountPort}`
  const result = await runDockerCommand([
    'run',
    '-d',
    '--name',
    SERVICE_CONTAINER_NAME,
    '--restart',
    'unless-stopped',
    '-v',
    `${dataDirPath}:/app/rootfs/data`,
    '-p',
    `${wrapperConfig.decryptPort}:${wrapperConfig.decryptPort}`,
    '-p',
    `${wrapperConfig.m3u8Port}:${wrapperConfig.m3u8Port}`,
    '-p',
    `${wrapperConfig.accountPort}:${wrapperConfig.accountPort}`,
    '-e',
    `args=${argsValue}`,
    IMAGE_NAME,
  ])

  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? 'Failed to start wrapper service.',
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    message: 'Wrapper service started.',
  }
}

export async function stopAppleMusicWrapperService(): Promise<AppleMusicWrapperCommandResult> {
  const currentState = await inspectContainerState(SERVICE_CONTAINER_NAME)
  if (currentState.state === 'missing') {
    return {
      ok: true,
      message: 'Wrapper service is already stopped.',
    }
  }

  const result = await runDockerCommand(['rm', '-f', SERVICE_CONTAINER_NAME])
  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? 'Failed to stop wrapper service.',
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    message: 'Wrapper service stopped.',
  }
}

export interface StartAppleMusicWrapperLoginOptions {
  username: string
  password: string
}

export async function startAppleMusicWrapperLogin(
  options: StartAppleMusicWrapperLoginOptions,
): Promise<AppleMusicWrapperCommandResult> {
  const username = options.username.trim()
  const password = options.password
  if (!username || !password) {
    return {
      ok: false,
      message: 'Username and password are required.',
    }
  }

  const wrapperDirPath = await ensureWrapperDir()
  const dataDirPath = await ensureDataDir(wrapperDirPath)
  const codeFilePath = getTwoFactorCodePath(wrapperDirPath)

  await cleanupContainer(LOGIN_CONTAINER_NAME)
  await rm(codeFilePath, { force: true })

  const argsValue = `-L ${username}:${password} -F -H 0.0.0.0`
  const result = await runDockerCommand([
    'run',
    '-d',
    '--name',
    LOGIN_CONTAINER_NAME,
    '-v',
    `${dataDirPath}:/app/rootfs/data`,
    '-e',
    `args=${argsValue}`,
    IMAGE_NAME,
  ])

  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? 'Failed to start wrapper login.',
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    message: 'Wrapper login started. Waiting for 2FA code file.',
  }
}

export async function stopAppleMusicWrapperLogin(): Promise<AppleMusicWrapperCommandResult> {
  const currentState = await inspectContainerState(LOGIN_CONTAINER_NAME)
  if (currentState.state === 'missing') {
    return {
      ok: true,
      message: 'Wrapper login container is already stopped.',
    }
  }

  const result = await runDockerCommand(['rm', '-f', LOGIN_CONTAINER_NAME])
  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? 'Failed to stop wrapper login container.',
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    message: 'Wrapper login container stopped.',
  }
}

export async function submitAppleMusicWrapperTwoFactorCode(
  code: string,
): Promise<AppleMusicWrapperCommandResult> {
  const normalized = code.trim()
  if (!/^\d{4,8}$/.test(normalized)) {
    return {
      ok: false,
      message: '2FA code must be a numeric code (4-8 digits).',
    }
  }

  const wrapperDirPath = await ensureWrapperDir()
  const codeFilePath = getTwoFactorCodePath(wrapperDirPath)
  await mkdir(dirname(codeFilePath), { recursive: true })
  await writeFile(codeFilePath, `${normalized}\n`, { encoding: 'utf-8' })

  return {
    ok: true,
    message: '2FA code written. Wrapper login will pick it up shortly.',
  }
}

export interface AppleMusicWrapperLogsResult {
  ok: boolean
  message: string
  logs: string
}

export async function getAppleMusicWrapperLogs(
  target: 'service' | 'login' = 'service',
): Promise<AppleMusicWrapperLogsResult> {
  const containerName =
    target === 'login' ? LOGIN_CONTAINER_NAME : SERVICE_CONTAINER_NAME
  const result = await runDockerCommand([
    'logs',
    '--tail',
    String(DEFAULT_LOG_TAIL),
    containerName,
  ])

  if (!result.ok) {
    return {
      ok: false,
      message: result.errorMessage ?? `Failed to fetch ${target} logs.`,
      logs: result.stderr,
    }
  }

  return {
    ok: true,
    message: `${target} logs fetched.`,
    logs: result.stdout.length > 0 ? result.stdout : result.stderr,
  }
}

export async function getAppleMusicWrapperMusicTokenPreview(): Promise<string> {
  const wrapperDirPath = await ensureWrapperDir()
  const tokenPath = getMusicTokenPath(wrapperDirPath)

  if (!(await pathExists(tokenPath))) return ''

  const fileStat = await stat(tokenPath).catch(() => null)
  if (!fileStat?.isFile()) return ''

  const content = await readFile(tokenPath, 'utf-8')
  const trimmed = content.trim()
  if (trimmed.length <= 20) return trimmed
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-6)}`
}
