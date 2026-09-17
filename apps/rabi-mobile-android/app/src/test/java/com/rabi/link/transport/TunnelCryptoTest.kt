package com.rabi.link.transport

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class TunnelCryptoTest {
    @Test fun nodeHandshakeAndBidirectionalFramesMatch() {
        val script = """
            import * as c from 'node:crypto'; import readline from 'node:readline';
            const pair=c.generateKeyPairSync('ed25519'), e=c.generateKeyPairSync('x25519');
            const pem=key=>key.export({type:'spki',format:'pem'}).toString();
            console.log(pem(pair.publicKey).replaceAll('\n','|'));
            const lines=readline.createInterface({input:process.stdin}); let cipher;
            lines.on('line',line=>{
              if(!cipher){
                const a=JSON.parse(line), {signature,...fields}=a;
                if(!c.verify(null,Buffer.from('rabi-tunnel-v1'+JSON.stringify(fields)),a.publicKey,Buffer.from(signature,'base64'))) throw Error('signature');
                const body={deviceId:'pc',generation:'generation',publicKey:pem(pair.publicKey),ephemeral:pem(e.publicKey),nonce:c.randomBytes(24).toString('hex'),target:'phone'};
                const b={...body,signature:c.sign(null,Buffer.from('rabi-tunnel-v1'+JSON.stringify(body)),pair.privateKey).toString('base64')};
                const secret=c.diffieHellman({privateKey:e.privateKey,publicKey:c.createPublicKey(a.ephemeral)});
                const derive=label=>Buffer.from(c.hkdfSync('sha256',secret,Buffer.from(JSON.stringify([a,b])),'rabi-tunnel-v1'+label,32));
                cipher={tx:derive('receiver'),rx:derive('caller')}; console.log(JSON.stringify(b));
                const iv=Buffer.alloc(12);iv.writeBigUInt64BE(1n,4);const enc=c.createCipheriv('aes-256-gcm',cipher.tx,iv);enc.setAAD(Buffer.from('rabi-tunnel-v1'));
                console.log(Buffer.concat([iv,enc.update(JSON.stringify({type:'ping',id:'node'})),enc.final(),enc.getAuthTag()]).toString('base64'));
              }else{
                const bytes=Buffer.from(line,'base64'),dec=c.createDecipheriv('aes-256-gcm',cipher.rx,bytes.subarray(0,12));dec.setAAD(Buffer.from('rabi-tunnel-v1'));dec.setAuthTag(bytes.subarray(-16));
                console.log(Buffer.concat([dec.update(bytes.subarray(12,-16)),dec.final()]).toString());lines.close();process.exit(0);
              }
            });
        """.trimIndent()
        val process=ProcessBuilder("node","--input-type=module","-e",script).start()
        try {
            val reader=process.inputStream.bufferedReader(); val writer=process.outputStream.bufferedWriter()
            val key=reader.readLine().replace('|','\n')
            val handshake=TunnelCrypto(ByteArray(32){it.toByte()},"phone","mobile-generation").handshake("pc",key)
            writer.write(handshake.hello); writer.newLine(); writer.flush()
            val cipher=handshake.accept(reader.readLine().toByteArray())
            val incoming=TunnelCrypto.unb64(reader.readLine())
            assertEquals("node",cipher.decode(incoming).getString("id"))
            try { cipher.decode(incoming); fail("replay accepted") } catch(_: IllegalArgumentException) {}
            writer.write(TunnelCrypto.b64(cipher.encode(JSONObject().put("type","pong").put("id","node")))); writer.newLine(); writer.flush()
            assertEquals("pong",JSONObject(reader.readLine()).getString("type"))
            assertTrue(process.waitFor(5,TimeUnit.SECONDS)); assertEquals(0,process.exitValue())
        } finally { process.destroyForcibly() }
    }
    @Test fun peerEnvelopeAuthenticatesApplicationAndRejectsCorruption() {
        val packet=TunnelCrypto.peerPacket(JSONObject().put("requestId","fixture"),"test-token")
        assertEquals("fixture",TunnelCrypto.openPeer(packet,"test-token").getString("requestId"))
        try { TunnelCrypto.openPeer(packet,"other-token"); fail("wrong application accepted") } catch(_: Exception) {}
    }
}
