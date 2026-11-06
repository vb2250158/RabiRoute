# Third-party notices

The Chinese, Japanese, and English phoneme conversion logic in `text/` is
adapted from the `text/` frontend distributed with
[Plachtaa/VITS-fast-fine-tuning](https://github.com/Plachtaa/VITS-fast-fine-tuning).
That frontend carries the following MIT notice:

> Copyright (c) 2017 Keith Ito
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

The ONNX graph execution order follows the same project's public Apache-2.0
ONNX export: `enc_p -> emb_g -> dp -> flow -> dec`. RabiSpeech's NumPy/ONNX
Runtime implementation does not copy the upstream PyTorch model source.

RabiSpeech does not redistribute model weights, voice recordings, speaker
tables, or generated audio. Those remain external local assets and must be
used according to their own licenses and the user's authorization.
