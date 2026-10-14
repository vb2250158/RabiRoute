package android.util;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** JVM read-only filesystem shim; this fixture does not test Android atomic writes. */
public final class AtomicFile {
    private final File file;
    public AtomicFile(File file) { this.file = file; }
    public File getBaseFile() { return file; }
    public FileInputStream openRead() throws IOException { return new FileInputStream(file); }
    public FileOutputStream startWrite() throws IOException { throw new IOException("Read-only history fixture"); }
    public void finishWrite(FileOutputStream stream) { throw new AssertionError("Unexpected history write"); }
    public void failWrite(FileOutputStream stream) { throw new AssertionError("Unexpected history write"); }
}
