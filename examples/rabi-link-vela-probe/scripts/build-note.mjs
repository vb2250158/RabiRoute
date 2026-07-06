import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  'src/manifest.json',
  'src/app.ux',
  'src/pages/index/index.ux'
]

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)))
if (missing.length) {
  console.error(`缺少文件: ${missing.join(', ')}`)
  process.exit(1)
}

console.log('Vela 快应用探针工程结构已就绪。')
console.log('请用 AIoT-IDE 打开 examples/rabi-link-vela-probe 后选择 watch 模拟器运行/打包 .rpk。')
