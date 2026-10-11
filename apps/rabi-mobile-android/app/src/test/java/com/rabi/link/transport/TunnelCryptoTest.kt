package com.rabi.link.transport

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.io.File

class TunnelCryptoTest {
    @Test(timeout=30000) fun delegatedEyeSignatureIsAcceptedOnlyForItsActualSourceAndDeadline() {
        val root=generateSequence(File(checkNotNull(System.getProperty("user.dir")))){it.parentFile}.first{File(it,"src/peerTunnel/runtime.ts").isFile}
        val script="""
            import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import readline from 'node:readline';
            import {PeerTunnelRuntime} from './src/peerTunnel/runtime.ts';
            import {createHash} from 'node:crypto';
            const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-eye-delegation-'));
            const runtime=new PeerTunnelRuntime({dataDir:directory,deviceId:'pc',generation:'host-generation',discover:async()=>[],signal:async()=>{},relay:()=>({url:'https://relay.invalid',token:'fixture-application'}),services:()=>({manager:{baseUrl:'http://127.0.0.1'}}),onStatus:()=>{},allowApplicationConnection:()=>true});
            const scope=createHash('sha256').update('https://relay.invalid\nfixture-application').digest('hex');
            try{for await(const line of readline.createInterface({input:process.stdin})){try{const body=JSON.parse(line);const result=body.kind?await runtime.offer(body):await runtime.grantDeviceConnection(body,{sourceDeviceId:'glasses-0123456789abcdef',scope,issuedAt:Date.now(),assertCurrent(){}});console.log(JSON.stringify({accepted:true,...result}));}catch(error){console.log(JSON.stringify({accepted:false,error:error.code||error.message}));}}}finally{runtime.stop();fs.rmSync(directory,{recursive:true,force:true});}
        """.trimIndent()
        val process=ProcessBuilder("node","--import","tsx","--input-type=module","-e",script).directory(root).start()
        try {
            val reader=process.inputStream.bufferedReader();val writer=process.outputStream.bufferedWriter()
            fun send(packet:JSONObject):JSONObject{writer.write(packet.toString());writer.newLine();writer.flush();return JSONObject(reader.readLine())}
            val crypto=TunnelCrypto(ByteArray(32){it.toByte()},"glasses-0123456789abcdef","eye-generation")
            val first=send(crypto.deviceBootstrap("pc",System.currentTimeMillis()+40000,java.util.UUID.randomUUID().toString()));assertTrue(first.toString(),first.getBoolean("accepted"))
            assertEquals("host-generation",first.getString("generation"));assertEquals("host-generation",first.getString("managerGeneration"))
            val renewed=send(crypto.deviceBootstrap("pc",System.currentTimeMillis()+40000,java.util.UUID.randomUUID().toString()));assertEquals(first.getString("epoch"),renewed.getString("epoch"))
            assertFalse(send(crypto.bootstrap("pc","manager")).getBoolean("accepted"))
            assertFalse(send(crypto.deviceBootstrap("pc",System.currentTimeMillis()+60000,java.util.UUID.randomUUID().toString())).getBoolean("accepted"))
            assertFalse(send(crypto.deviceBootstrap("pc",System.currentTimeMillis()+40000,java.util.UUID.randomUUID().toString()).put("source","glasses-fedcba9876543210")).getBoolean("accepted"))
            writer.close();assertTrue(process.waitFor(5,TimeUnit.SECONDS));assertEquals(process.errorStream.bufferedReader().readText(),0,process.exitValue())
        }finally{process.destroyForcibly()}
    }
    @Test(timeout=30000) fun managerBootstrapUsesTheApplicationContractAcceptedByTheActualPcRuntime() {
        val root=generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it,"src/peerTunnel/runtime.ts").isFile }
        val script="""
            import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline';
            import {PeerTunnelRuntime} from './src/peerTunnel/runtime.ts';
            const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-manager-bootstrap-'));
            const runtime=new PeerTunnelRuntime({dataDir:directory,deviceId:'pc',generation:'actual-pc-generation',
              discover:async()=>[],signal:async()=>{throw Error('unused');},relay:()=>({url:'https://relay.invalid',token:'fixture-application'}),
              services:()=>({manager:{baseUrl:'http://127.0.0.1'}}),onStatus:()=>{},allowApplicationConnection:()=>true});
            try {for await(const line of readline.createInterface({input:process.stdin})) {
              try {const packet=JSON.parse(line);if(packet.kind!=='bootstrap-application')throw Error('wrong-contract');
                const response=await runtime.offer(packet);const grant=JSON.parse(fs.readFileSync(path.join(directory,'tunnel.json'))).trustedDevices[0];
                console.log(JSON.stringify({accepted:true,deviceId:response.deviceId,source:grant.deviceId,publicKey:grant.publicKey,services:grant.services}));
              } catch(error){console.log(JSON.stringify({accepted:false,error:error.code || error.message}));}
            }}finally{runtime.stop();fs.rmSync(directory,{recursive:true,force:true});}
        """.trimIndent()
        val process=ProcessBuilder("node","--import","tsx","--input-type=module","-e",script).directory(root).start()
        try {
            val reader=process.inputStream.bufferedReader();val writer=process.outputStream.bufferedWriter()
            val crypto=TunnelCrypto(ByteArray(32){it.toByte()},"phone","mobile-generation")
            fun send(packet:JSONObject):JSONObject {writer.write(packet.toString());writer.newLine();writer.flush();return JSONObject(reader.readLine())}
            for(service in listOf("manager","speech","resources")) {
                val result=send(crypto.bootstrap("pc",service));assertTrue(result.getBoolean("accepted"));assertEquals("pc",result.getString("deviceId"))
                assertEquals("phone",result.getString("source"));assertEquals(crypto.publicKey,result.getString("publicKey"));assertEquals(0,result.getJSONArray("services").length())
            }
            assertFalse(send(crypto.bootstrap("pc","manager").put("source","forged-source")).getBoolean("accepted"))
            assertFalse(send(crypto.bootstrap("pc","manager").put("expiresAt",0)).getBoolean("accepted"))
            writer.close();assertTrue(process.waitFor(5,TimeUnit.SECONDS));assertEquals(process.errorStream.bufferedReader().readText(),0,process.exitValue())
        } finally {process.destroyForcibly()}
    }
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
