package com.rabi.link.recording;
import org.junit.Test;
import static org.junit.Assert.*;
public class CaptureCompletionPolicyTest {
    @Test public void saveFailureNeverStartsNext() {
        assertFalse(CaptureCompletionPolicy.mayRestart(true, true, true, false));
        assertTrue(CaptureCompletionPolicy.mayRestart(true, true, false, false));
        assertFalse(CaptureCompletionPolicy.mayRestart(true, false, false, false));
        assertFalse(CaptureCompletionPolicy.mayRestart(true, true, false, true));
    }
    @Test public void delayedCallbackCannotEnterReplacementCapture() {
        assertTrue(CaptureCompletionPolicy.acceptsCallback(1,1,1,false,false,true,true,true));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,2,2,false,false,true,true,true));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,1,-1,false,false,true,true,true));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,1,1,false,true,true,true,true));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,1,1,false,false,true,false,true));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,1,1,false,false,true,true,false));
        assertFalse(CaptureCompletionPolicy.acceptsCallback(1,1,1,true,false,true,true,true));
    }
}
