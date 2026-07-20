import fs from 'node:fs'
import path from 'node:path'
import forge from 'node-forge'

const root = path.resolve(import.meta.dirname, '..')
const pemDir = path.join(
  root,
  'node_modules',
  '@aiot-toolkit',
  'aiotpack',
  'lib',
  'compiler',
  'javascript',
  'vela',
  'utils',
  'signature',
  'pem'
)

const certPath = path.join(pemDir, 'certificate.pem')
const keyPath = path.join(pemDir, 'private.pem')
const androidDir = path.resolve(root, '..', '..', 'apps', 'rabilink-android')
const outDir = path.join(androidDir, 'signing')
const outPath = path.join(outDir, 'vela-debug.p12')
const password = 'rabiroute'

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('未找到 Vela debug PEM，请先运行 npm install。')
  process.exit(1)
}

const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'))
const key = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'))
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, {
  algorithm: '3des',
  friendlyName: 'vela-debug'
})
const der = forge.asn1.toDer(p12Asn1).getBytes()

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outPath, Buffer.from(der, 'binary'))

console.log(`已生成 Android PKCS#12 keystore: ${outPath}`)
console.log('alias=vela-debug')
console.log('storePassword/keyPassword=rabiroute')
