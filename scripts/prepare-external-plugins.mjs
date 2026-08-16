import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginsRoot = join(repositoryRoot, 'plugins')
const lock = JSON.parse(await readFile(join(repositoryRoot, 'external-plugins.json'), 'utf8'))

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (options.capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      const detail = signal ? `signal ${signal}` : `code ${code}`
      reject(new Error(`${command} ${args.join(' ')} exited with ${detail}${stderr ? `\n${stderr.trim()}` : ''}`))
    })
  })
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function pnpmInvocation(args) {
  if (process.env.npm_execpath?.toLowerCase().includes('pnpm')) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] }
  }
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    }
  }
  return { command: 'pnpm', args }
}

if (!Array.isArray(lock.plugins) || lock.plugins.length === 0) {
  throw new Error('external-plugins.json must declare at least one pinned plugin')
}

await mkdir(pluginsRoot, { recursive: true })

for (const plugin of lock.plugins) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(plugin.repository)
    || !/^[a-f0-9]{40}$/.test(plugin.commit)) {
    throw new Error(`Invalid external plugin lock entry: ${JSON.stringify(plugin)}`)
  }

  const target = join(pluginsRoot, plugin.id)
  const gitDirectory = join(target, '.git')
  const existed = await pathExists(target)
  const isRepository = await pathExists(gitDirectory)

  if (existed && !isRepository) {
    throw new Error(`${plugin.id}: ${target} exists but is not an independent Git repository`)
  }

  if (!isRepository) {
    console.log(`[plugins] Cloning ${plugin.repository} into ${target}`)
    await run('git', ['clone', '--filter=blob:none', '--no-tags', plugin.repository, target])
    const clonedHead = await run('git', ['rev-parse', 'HEAD'], { cwd: target, capture: true })
    if (clonedHead !== plugin.commit) {
      await run('git', ['fetch', '--depth', '1', 'origin', plugin.commit], { cwd: target })
      await run('git', ['checkout', '--detach', plugin.commit], { cwd: target })
    }
  }

  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: target, capture: true })
  if (head !== plugin.commit) {
    throw new Error(
      `${plugin.id}: local HEAD ${head} differs from pinned commit ${plugin.commit}; `
      + 'commit the plugin work and update external-plugins.json together',
    )
  }

  const invocation = pnpmInvocation(['--dir', target, 'install', '--frozen-lockfile'])
  await run(invocation.command, invocation.args)
  console.log(`[plugins] Ready ${plugin.id} at ${plugin.commit.slice(0, 12)}`)
}
