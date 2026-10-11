package com.rabi.link.transport

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.java_websocket.WebSocket
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshake
import org.java_websocket.server.WebSocketServer
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class PhoneEyeHttpServerTest {
    private fun line(input: InputStream): String {
        val bytes=ByteArrayOutputStream()
        while(true){val next=input.read();check(next>=0);if(next==10)break;if(next!=13)bytes.write(next)}
        return bytes.toString("US-ASCII")
    }
    private fun head(input: InputStream): Pair<String,Map<String,String>> {
        val status=line(input);val headers=mutableMapOf<String,String>()
        while(true){val item=line(input);if(item.isEmpty())break;val index=item.indexOf(':');headers[item.substring(0,index).lowercase()]=item.substring(index+1).trim()}
        return status to headers
    }
    private fun socket(server:PhoneEyeHttpServer)=Socket("127.0.0.1",server.port).apply{soTimeout=4000}
    private fun send(socket:Socket,request:String){socket.getOutputStream().apply{write(request.toByteArray(Charsets.US_ASCII));flush()}}
    private fun body(input:InputStream,size:Int):ByteArray {val bytes=ByteArray(size);var offset=0;while(offset<size){val count=input.read(bytes,offset,size-offset);check(count>0);offset+=count};return bytes}

    @Test fun oversizedDeclaredBodyRejectsBeforeCallback() {
        val calls=AtomicInteger()
        PhoneEyeHttpServer({ _,sink -> calls.incrementAndGet();sink.begin(200);sink.end() }).use { server ->
            socket(server).use { client ->
                send(client,"POST /session HTTP/1.1\r\nHost: localhost\r\nContent-Length: 12582913\r\n\r\n")
                assertFalse(head(client.getInputStream()).first.contains("200"))
                assertEquals(0,calls.get())
            }
        }
    }

    @Test fun bufferedConstructorRemainsCompatible() {
        PhoneEyeHttpServer { path,headers,json -> check(path=="/session" && headers["x-test"]=="paired");JSONObject().put("value",json.getInt("value")) }.use { server ->
            socket(server).use { client ->
                send(client,"POST /session HTTP/1.1\r\nHost: localhost\r\nX-Test: paired\r\nContent-Length: 11\r\n\r\n{\"value\":7}")
                val input=client.getInputStream();val (status,headers)=head(input)
                assertTrue(status.contains("200"));assertEquals(7,JSONObject(String(body(input,headers.getValue("content-length").toInt()))).getInt("value"))
            }
        }
    }

    @Test fun chunkedUploadAndIncrementalResponseDoNotWaitForEnd() {
        val release=CountDownLatch(1);val received=AtomicReference<String>()
        PhoneEyeHttpServer({ request,sink ->
            assertEquals("PATCH",request.method);assertEquals("/api/future?raw=a%2Fb",request.path)
            received.set(String(request.body.readBytes()))
            sink.begin(207,mapOf("x-future" to "preserved"));sink.write("first".toByteArray())
            check(release.await(4,TimeUnit.SECONDS));sink.write("second".toByteArray());sink.end()
        }).use { server ->
            socket(server).use { client ->
                send(client,"PATCH /api/future?raw=a%2Fb HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n")
                val input=client.getInputStream();val (status,headers)=head(input)
                assertTrue(status.contains("207"));assertEquals("chunked",headers["transfer-encoding"])
                assertEquals("preserved",headers["x-future"]);assertEquals("abcde",received.get())
                assertEquals("5",line(input));assertEquals("first",String(body(input,5)));assertEquals("",line(input))
                release.countDown();assertEquals("6",line(input));assertEquals("second",String(body(input,6)));assertEquals("",line(input));assertEquals("0",line(input));assertEquals("",line(input))
            }
        }
    }

    @Test fun binaryBodyAndFutureMethodPassWithoutJsonInterpretation() {
        val bytes=byteArrayOf(0,1,127,-1)
        PhoneEyeHttpServer({ request,sink ->
            assertEquals("PUT",request.method);assertArrayEquals(bytes,request.body.readBytes())
            sink.begin(200,mapOf("content-type" to "application/octet-stream"),bytes.size.toLong());sink.write(bytes);sink.end()
        }).use { server ->
            socket(server).use { client ->
                send(client,"PUT /arbitrary-future HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n")
                client.getOutputStream().apply{write(bytes);flush()};head(client.getInputStream());assertArrayEquals(bytes,body(client.getInputStream(),4))
            }
        }
    }

    @Test fun headRetainsLengthWithoutResponseBytesOrChunkedFraming() {
        PhoneEyeHttpServer({request,sink->assertEquals("HEAD",request.method);sink.begin(200,mapOf("content-type" to "application/octet-stream"),212);sink.end()}).use{server->
            socket(server).use{client->send(client,"HEAD /future HTTP/1.1\r\nHost: localhost\r\n\r\n");val(status,headers)=head(client.getInputStream());assertTrue(status.contains("200"));assertEquals("212",headers["content-length"]);assertNull(headers["transfer-encoding"]);assertEquals(-1,client.getInputStream().read())}
        }
    }

    @Test fun duplexUploadCanReceiveResponseBeforeRequestBodyCompletes() {
        PhoneEyeHttpServer({request,sink->
            val prefix=body(request.body,3);sink.begin(200);sink.write(prefix)
            sink.write(request.body.readBytes());sink.end()
        }).use{server->socket(server).use{client->
            send(client,"POST /future-duplex HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nabc")
            val input=client.getInputStream();head(input);assertEquals("3",line(input));assertEquals("abc",String(body(input,3)));line(input)
            send(client,"de");assertEquals("2",line(input));assertEquals("de",String(body(input,2)));line(input);assertEquals("0",line(input));line(input)
        }}
    }

    @Test fun ambiguousLengthAndUpgradeWithoutAdmissionFailBeforeCallback() {
        val calls=AtomicInteger()
        PhoneEyeHttpServer({ _,sink ->calls.incrementAndGet();sink.begin(200,emptyMap(),0);sink.end()}).use { server ->
            for(request in listOf("POST /future HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n", "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")) {
                socket(server).use{client->send(client,request);assertTrue(head(client.getInputStream()).first.contains("403"))}
            }
            assertEquals(0,calls.get())
        }
    }

    @Test fun closeTerminatesActiveAsyncStreamAndWaitingClient() {
        val started=CountDownLatch(1)
        val server=PhoneEyeHttpServer({ _,sink->sink.begin(200);sink.write("active".toByteArray());started.countDown()})
        socket(server).use { client ->
            send(client,"GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n");assertTrue(started.await(4,TimeUnit.SECONDS))
            val input=client.getInputStream();head(input);assertEquals("6",line(input));body(input,6);line(input)
            server.close();assertEquals(-1,input.read())
        }
        server.close()
    }

    @Test fun actualWebSocketClientUsesUpstreamHandshakeAndRawBidirectionalFrames() {
        val ready=CountDownLatch(1);val connects=AtomicInteger()
        val upstream=object:WebSocketServer(InetSocketAddress("127.0.0.1",0)) {
            override fun onOpen(connection:WebSocket,handshake:ClientHandshake){connects.incrementAndGet()}
            override fun onClose(connection:WebSocket,code:Int,reason:String,remote:Boolean){}
            override fun onMessage(connection:WebSocket,message:String){connection.send(message)}
            override fun onMessage(connection:WebSocket,message:ByteBuffer){connection.send(message)}
            override fun onError(connection:WebSocket?,exception:Exception){}
            override fun onStart(){ready.countDown()}
        }
        upstream.start();assertTrue(ready.await(4,TimeUnit.SECONDS))
        val error=AtomicReference<Exception>();val text=CountDownLatch(1);val binary=CountDownLatch(1)
        val server=PhoneEyeHttpServer({_,sink->sink.begin(404,emptyMap(),0);sink.end()}, {request,sink->
            check(request.headers["x-pairing"]=="paired")
            Socket("127.0.0.1",upstream.port).use { remote ->
                remote.soTimeout=4000
                val output=remote.getOutputStream()
                output.write(("${request.method} ${request.path} HTTP/1.1\r\n"+request.headers.entries.joinToString(""){"${it.key}: ${it.value}\r\n"}+"\r\n").toByteArray(Charsets.US_ASCII));output.flush()
                val (status,headers)=head(remote.getInputStream());sink.begin(status.split(' ')[1].toInt(),headers)
                val incoming=Thread{try{val buffer=ByteArray(1024);while(true){val count=request.body.read(buffer);if(count<0)break;output.write(buffer,0,count);output.flush()}}catch(exception:java.io.IOException){if(!remote.isClosed)error.set(exception)}finally{remote.close()}}.apply{isDaemon=true;start()}
                try{val buffer=ByteArray(1024);while(true){val count=remote.getInputStream().read(buffer);if(count<0)break;sink.write(buffer,0,count)}}finally{sink.end();remote.close();incoming.join(1000)}
            }
        })
        val client=object:WebSocketClient(URI("ws://127.0.0.1:${server.port}/future-ws"),mapOf("x-pairing" to "paired")) {
            override fun onOpen(handshake:ServerHandshake){}
            override fun onMessage(message:String){if(message=="future text")text.countDown()}
            override fun onMessage(message:ByteBuffer){if(message.remaining()==4)binary.countDown()}
            override fun onClose(code:Int,reason:String,remote:Boolean){}
            override fun onError(exception:Exception){error.set(exception)}
        }
        try {
            assertTrue(client.connectBlocking(4,TimeUnit.SECONDS));client.send("future text");client.send(byteArrayOf(0,1,127,-1))
            assertTrue(text.await(4,TimeUnit.SECONDS));assertTrue(binary.await(4,TimeUnit.SECONDS));assertNull(error.get());assertEquals(1,connects.get())
        } finally {client.closeBlocking();server.close();upstream.stop(1000)}
    }
}
