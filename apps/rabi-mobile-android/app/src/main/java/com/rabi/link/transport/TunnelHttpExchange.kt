package com.rabi.link.transport

import org.json.JSONObject
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** One generic HTTP/upgrade stream over the existing encrypted frame protocol. */
internal class TunnelHttpExchange(private val send:(JSONObject)->Unit,private val read:(Long)->JSONObject?,private val assertCurrent:()->Unit,private val closeTimeoutMs:Long=1000) {
    fun run(service:String,method:String,path:String,headers:JSONObject,input:InputStream,upgrade:Boolean,
            onHead:(Int,JSONObject)->Unit,onData:(ByteArray)->Unit,timeoutMs:Long) {
        val id=UUID.randomUUID().toString();val lock=Object();var credit=65536;val done=java.util.concurrent.atomic.AtomicBoolean(false)
        val failure=AtomicReference<Throwable?>();val deadline=System.nanoTime()+timeoutMs*1_000_000
        fun frame(value:JSONObject){assertCurrent();send(value)}
        frame(JSONObject().put("type","open").put("id",id).put("request",JSONObject().put("service",service).put("method",method).put("path",path).put("headers",headers).put("upgrade",upgrade)))
        val writer=Thread({try {
            val bytes=ByteArray(12000)
            while(!done.get()){val length=input.read(bytes);if(length<0)break;var offset=0
                while(offset<length){val size=synchronized(lock){while(credit==0 && !done.get()){assertCurrent();lock.wait(500)};check(!done.get());minOf(credit,length-offset).also{credit-=it}}
                    frame(JSONObject().put("type","data").put("id",id).put("data",TunnelCrypto.b64(bytes.copyOfRange(offset,offset+size))));offset+=size}
            }
            if(!done.get())frame(JSONObject().put("type","end").put("id",id))
        }catch(error:Throwable){if(!done.get())failure.set(error)}},"rabi-tunnel-http-writer").apply{isDaemon=true}
        writer.start()
        try {
            var headed=false
            while(!done.get()){assertCurrent();failure.get()?.let{throw it};val remaining=(deadline-System.nanoTime())/1_000_000;check(remaining>0){"TUNNEL_STREAM_TIMEOUT"}
                val value=read(minOf(remaining,1000)) ?: continue;assertCurrent()
                if(value.getString("type")=="ping"){frame(JSONObject().put("type","pong").put("id",value.getString("id")));continue}
                if(value.optString("id")!=id)continue
                when(value.getString("type")){
                    "window"->synchronized(lock){val size=value.getInt("bytes");require(size>0 && credit+size<=65536);credit+=size;lock.notifyAll()}
                    "head"->{check(!headed);headed=true;val head=value.getJSONObject("head");onHead(head.getInt("status"),head.optJSONObject("headers") ?: JSONObject())}
                    "data"->{check(headed);val bytes=TunnelCrypto.unb64(value.getString("data"));require(bytes.size<=12000);onData(bytes);frame(JSONObject().put("type","window").put("id",id).put("bytes",bytes.size))}
                    "end"->done.set(true)
                    "reset"->error("TUNNEL_STREAM_RESET")
                    else->error("TUNNEL_STREAM_FRAME_INVALID")
                }
            }
            assertCurrent()
        }finally{done.set(true);synchronized(lock){lock.notifyAll()};runCatching{input.close()};writer.interrupt();writer.join(closeTimeoutMs)}
    }
}
