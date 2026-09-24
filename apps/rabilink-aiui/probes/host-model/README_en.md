# Rabi conversation v0.5

Standalone streaming ASR → one host LanguageModel session → incremental text and sentence TTS queue. Interim captions never submit until final. Bubble and fullscreen reading layouts preserve the session and recognition; manual paging stops following until Latest is selected.

Device battery uses the documented navigator.getBattery only with a nonempty AIUI device identity. Percentage/charging updates are observed while visible. Timeout, rejection, absent identity, or invalid values remain unknown, with a diagnostic reason. Actual glasses percentage still requires device comparison.

The only model tools are close_app (explicit current-user exit request, Page.finish) and set_display_mode (bubble/fullscreen enum). No hardware screen-off API is implemented or claimed. There is no fabricated tool-result protocol. Official speak has no reliable completion or cancellation contract; queued audio may continue after exit, and ASR resumes after accumulated estimated duration.

No PC/Relay, credentials, external messaging tools, or persistent audio/text. Host services may use cloud computation. Default pages/home/index and compatibility pages/index/index. Import the directory into Studio. Tests use host doubles; Ink preview verifies rendering only.
