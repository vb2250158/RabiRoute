package com.rabi.link.transport

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

class TunnelHttpExchangeTest {
    @Test(timeout=30000) fun actualEyeCipherCarriesFutureBinarySseAndUpgradeThroughPcManager() {
        val root=generateSequence(File(checkNotNull(System.getProperty("user.dir")))){it.parentFile}.first{File(it,"src/peerTunnel/runtime.ts").isFile}
        val script="""
            import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import readline from 'node:readline';import http from 'node:http';import {once} from 'node:events';import {createHash} from 'node:crypto';
            import {PeerTunnelRuntime} from './src/peerTunnel/runtime.ts';import {validateInternalManagerHop} from './src/shared/internalManagerHop.ts';
            const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-eye-http-')),scope=createHash('sha256').update('https://relay.invalid\nfixture-application').digest('hex');let url='';
            const runtime=new PeerTunnelRuntime({dataDir:dir,deviceId:'pc',generation:'host-generation',discover:async()=>[],signal:async()=>{},relay:()=>({url:'https://relay.invalid',token:'fixture-application'}),services:()=>({manager:{baseUrl:url}}),onStatus:()=>{},allowApplicationConnection:()=>true});
            const server=http.createServer(async(req,res)=>{const principal=validateInternalManagerHop(req,{generation:'host-generation',scope});if(principal?.deviceId!=='glasses-0123456789abcdef'){res.writeHead(403);res.end();return;}
              res.setHeader('x-actual-eye-source',principal.deviceId);
              if(req.url==='/future/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');setTimeout(()=>res.end('data: second\n\n'),25);return;}
              const chunks=[];for await(const chunk of req)chunks.push(chunk);res.writeHead(201,{'content-type':'application/octet-stream'});res.end(Buffer.concat(chunks));});
            server.on('upgrade',(req,socket,head)=>{if(runtime.upgrade(req,socket,head))return;const principal=validateInternalManagerHop(req,{generation:'host-generation',scope});if(principal?.deviceId!=='glasses-0123456789abcdef'){socket.destroy();return;}
              socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Actual-Eye-Source: '+principal.deviceId+'\r\n\r\n');socket.on('data',bytes=>socket.write(bytes));socket.on('end',()=>socket.end());});
            server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;console.log(url);
            try{for await(const line of readline.createInterface({input:process.stdin})){const packet=JSON.parse(line);console.log(JSON.stringify(await runtime.grantDeviceConnection(packet,{sourceDeviceId:'glasses-0123456789abcdef',scope,issuedAt:Date.now(),assertCurrent(){}})));}}finally{runtime.stop();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});}
        """.trimIndent()
        val process=ProcessBuilder("node","--import","tsx","--input-type=module","-e",script).directory(root).start()
        try {
            val reader=process.inputStream.bufferedReader();val writer=process.outputStream.bufferedWriter();val url=reader.readLine()
            val crypto=TunnelCrypto(ByteArray(32){it.toByte()},"glasses-0123456789abcdef","eye-generation")
            writer.write(crypto.deviceBootstrap("pc",System.currentTimeMillis()+40000,UUID.randomUUID().toString()).toString());writer.newLine();writer.flush()
            val grant=JSONObject(reader.readLine())
            fun exchange(path:String,bytes:ByteArray,upgrade:Boolean=false):Pair<Int,ByteArray> {
                TunnelChannel.websocket(url.replace("http:","ws:")+"/api/rabilink/peer/tunnel/socket?source=glasses-0123456789abcdef",emptyMap(),5000).use{channel->
                    val handshake=crypto.handshake("pc",grant.getString("publicKey"),"host-generation");channel.send(handshake.hello.toByteArray());val cipher=handshake.accept(channel.read(5000))
                    var status=0;val output=ByteArrayOutputStream()
                    TunnelHttpExchange({channel.send(cipher.encode(it))},{timeout->channel.poll(timeout)?.let(cipher::decode)},{check(grant.getLong("expiresAt")>System.currentTimeMillis())})
                        .run("manager",if(upgrade||path.endsWith("events"))"GET" else "POST",path,JSONObject(),ByteArrayInputStream(bytes),upgrade,{code,headers->status=code;assertEquals("glasses-0123456789abcdef",headers.getString("x-actual-eye-source"))},{output.write(it)},10000)
                    return status to output.toByteArray()
                }
            }
            val binary=ByteArray(180000){(it%256).toByte()};val response=exchange("/future/not-in-catalog",binary);assertEquals(201,response.first);assertArrayEquals(binary,response.second)
            val events=exchange("/future/events",ByteArray(0));assertEquals(200,events.first);assertEquals("data: first\n\ndata: second\n\n",String(events.second))
            val duplex=exchange("/future/socket","original-upgrade-bytes".toByteArray(),true);assertEquals(101,duplex.first);assertEquals("original-upgrade-bytes",String(duplex.second))
            writer.close();assertTrue(process.waitFor(5,TimeUnit.SECONDS));assertEquals(process.errorStream.bufferedReader().readText(),0,process.exitValue())
        }finally{process.destroyForcibly()}
    }
}
