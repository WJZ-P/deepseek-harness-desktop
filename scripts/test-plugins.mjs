import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginGroups = ['desktop-plugins', 'plugins']
const tests = []

for (const group of pluginGroups) {
  const root = join(repositoryRoot, group)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries.filter(row => row.isDirectory())) {
    const testRoot = join(root, entry.name, 'test')
    let files
    try {
      files = await readdir(testRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.test.mjs')) {
        tests.push(join(testRoot, file.name))
      }
    }
  }
}

tests.sort((a, b) => a.localeCompare(b))
if (tests.length === 0) throw new Error('No plugin tests were discovered')

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', ...tests], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(signal ? `Plugin tests ended with ${signal}` : `Plugin tests exited with code ${code}`))
  })
})
