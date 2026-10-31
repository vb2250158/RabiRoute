package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.*
import android.os.Bundle
import com.rabi.link.location.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Storage checks keep fixtures isolated. Credential import is an explicit test-only action. */
class LocationInstrumentation : Instrumentation() {
    private var action = "storage"
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); action=arguments.getString("action","storage"); start() }
    override fun onStart() {
        val output=Bundle(); var code=Activity.RESULT_OK
        try {
            when(action) {
                "import" -> {
                    val file=File(targetContext.filesDir,"location-key-import.txt")
                    try { LocationSettings(targetContext).saveKey(file.readText().trim()); check(LocationSettings(targetContext).hasKey) }
                    finally { file.delete() }
                    output.putString("result","PASS: key imported into encrypted phone settings; transfer file removed")
                }
                "audit" -> LocationRepository(targetContext).use { repository ->
                    val points=repository.recent(0,Long.MAX_VALUE,1)
                    output.putLong("storedPoints",repository.count(0,Long.MAX_VALUE))
                    output.putLong("latestTime",points.firstOrNull()?.point?.time ?: 0)
                    output.putInt("sdkStartsThisMonth",repository.used(System.currentTimeMillis()))
                }
                else -> storage(output)
            }
        } catch(error: Throwable) { code=Activity.RESULT_CANCELED; output.putString("error",if(action=="import") "Credential import failed; no key output" else error.message ?: error.javaClass.simpleName) }
        finish(code,output)
    }
    private fun storage(output: Bundle) {
        val name="location-test-${System.nanoTime()}"
        val isolated=object: ContextWrapper(targetContext) {
            override fun getSharedPreferences(key:String,mode:Int): SharedPreferences = super.getSharedPreferences("$name-$key",mode)
        }
        val db="$name.db"
        try {
            val config=LocationSettings(isolated)
            check(!config.enabled && !config.hasKey && !config.privacyAccepted)
            check(config.sampling == SamplingConfig())
            val sampling = SamplingConfig(90_000, 10_000, 25.0)
            config.save(false, false, 100, sampling)
            check(LocationSettings(isolated).sampling == sampling)
            val fake="fixtureOnlyNotARealCredential0001"
            config.saveKey(fake)
            check(config.key()==fake)
            check(!isolated.getSharedPreferences("rabi_location",0).all.values.any { it.toString().contains(fake) })
            config.clearKey(); check(!config.hasKey)
            LocationRepository(targetContext,db).use { repository ->
                val now=System.currentTimeMillis()
                val point=LocationPoint(now,1,39.9,116.4,5f,"fixture")
                val id=repository.add(point)
                repository.label(id,point,"fixture address",true)
                check(repository.count(now,now+1)==1L)
                check(repository.cached(point,now)=="fixture address")
                check(repository.cached(point.copy(latitude=40.0),now)==null)
                val bytes=ByteArrayOutputStream(); repository.export(now,now+1,bytes)
                val feature=JSONObject(bytes.toString("UTF-8")).getJSONArray("features").getJSONObject(0)
                check(feature.getJSONObject("geometry").getJSONArray("coordinates").getDouble(0)==116.4)
                check(feature.getJSONObject("properties").getString("address")=="fixture address")
                val second=LocationRepository(targetContext,db)
                val workers=Executors.newFixedThreadPool(4)
                repeat(20) { i -> workers.execute { (if(i%2==0) repository else second).reserveRequest(now,7) } }
                workers.shutdown(); check(workers.awaitTermination(10,TimeUnit.SECONDS)); check(repository.used(now)==7)
                check(!second.reserveRequest(now,7)); check(second.used(now+40L*86400000)==0); second.close()
            }
            LocationRepository(targetContext,db).use { check(it.recent(0,Long.MAX_VALUE).size==1) }
            timeline(db)
            output.putString("result","PASS: timeline projection and bidirectional pagination; mixed-kind boundaries; label revision; sampling settings persist; encrypted key roundtrip; samples survive reopen; WGS84 export; nearby cache; concurrent quota cap")
        } finally { targetContext.deleteDatabase(db); targetContext.deleteSharedPreferences("$name-rabi_location") }
    }
    private fun timeline(database: String) {
        LocationRepository(targetContext,database).use { repository ->
            repeat(205) { index -> repository.add(LocationPoint(if(index < 110) 1000 else 2000,1,39.9,116.4,5f,"fixture")) }
            val expected = repository.recent(0,Long.MAX_VALUE,1000).map { LocationRepository.recordId(it.id) }
            val reader = com.rabi.link.recording.LocationRecordingReader(targetContext,database)
            val initial = reader.read(0,Long.MAX_VALUE,0,"",null)
            check(initial.map { it.entry.id } == expected)
            check(initial.all { it.entry.kind == "location" && it.entry.source == "phone" && it.entry.files.isEmpty() && it.entry.started == it.sample.point.time })
            for(older in listOf(true,false)) {
                val seen = mutableListOf<String>()
                var time = if(older) Long.MAX_VALUE else 0L
                var cursor = if(older) "\uffff" else ""
                do {
                    val page = reader.read(0,Long.MAX_VALUE,time,cursor,older)
                    val rows = page.take(100)
                    seen.addAll(rows.map { it.entry.id })
                    rows.lastOrNull()?.let { time=it.entry.started; cursor=it.entry.id }
                } while(page.size > 100)
                check(seen == if(older) expected else expected.reversed()) { "Location pagination lost or duplicated rows" }
            }
            check(repository.page(1000,"audio-boundary",true).isEmpty())
            check(repository.page(1000,"video-boundary",true).size == 101)
            val sample = repository.recent(0,Long.MAX_VALUE,1).single()
            val revision = LocationRepository.revision()
            repository.label(sample.id,sample.point,"updated fixture place",false)
            check(LocationRepository.revision() > revision)
            check(reader.read(sample.point.time,sample.point.time+1,0,"",null).single().sample.address == "updated fixture place")
            check(reader.read(1001,2000,0,"",null).isEmpty())
        }
    }
}
