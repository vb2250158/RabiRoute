// Authored test inputs, not captured speech, user conversations or credentials.
export const diagnosticSampleText = 'generated example';
export const diagnosticTranscript = '示例音频内容';
export const createDiagnosticSample = async () => Buffer.from(diagnosticSampleText);
export const createSystemPcmFixture = () => Buffer.alloc(32000, 7);
