using System.Runtime.InteropServices;

namespace RabiRoute.WindowsBootstrap;

internal static class BootstrapConsole
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    internal static void AttachToParent()
    {
        AttachConsole(AttachParentProcess);
        try
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
        }
        catch (IOException) { }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);
}
