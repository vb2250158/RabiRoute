package android.util;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** JVM filesystem shim for store round trips; Android crash atomicity needs device tests. */
public final class AtomicFile {
    private final File file;
    public AtomicFile(File file) { this.file = file; }
    public File getBaseFile() { return file; }
    public FileInputStream openRead() throws IOException { return new FileInputStream(file); }
    public FileOutputStream startWrite() throws IOException { return new FileOutputStream(new File(file.getPath() + ".new")); }
    public void finishWrite(FileOutputStream stream) throws IOException {
        stream.getFD().sync(); stream.close();
        java.nio.file.Files.move(new File(file.getPath() + ".new").toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
    public void failWrite(FileOutputStream stream) throws IOException {
        stream.close(); java.nio.file.Files.deleteIfExists(new File(file.getPath() + ".new").toPath());
    }
}
