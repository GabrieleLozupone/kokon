# AI marking

Every image Kokon makes or changes with its model is marked as AI-generated in two ways, as
Article 50(2) of the EU AI Act asks of generative AI systems: a line in the file's metadata, and an
invisible watermark in the pixels. This page says what the marks contain, how anyone can read them,
and how well the watermark survives common changes. It follows the European Commission's
[Code of Practice on marking and labelling AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)
(June 2026) and its [guidelines on Article 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50) (July 2026).

**Please don't remove or alter these marks** when you share Kokon images, except for legitimate
reasons such as security research. They tell people the image was made with AI.

## What is marked

| Result | Metadata (IPTC Digital Source Type) | Watermark |
|---|---|---|
| Generate, Compose | `trainedAlgorithmicMedia` | yes |
| Edit, brushed areas, Expand, references, Layers lab | `compositeWithTrainedAlgorithmicMedia` | yes |
| Upscale or colour LUT of a Kokon result | the type of that result | yes |
| Upscale or colour LUT of an imported image | `algorithmicallyEnhanced` | no (standard editing) |
| ... of an imported image that was already AI-made (its metadata says so, or it carries Kokon's watermark) | the type it declared | yes |
| Layers lab, Export PSD | `compositeWithTrainedAlgorithmicMedia` (metadata only) | in the layers it came from |

Upscaling and colour changes of your own photos are not marked as AI-generated: the Commission's
guidelines list rescaling, colour adjustments and sharpening as standard editing, outside Article
50(2). Images smaller than 150 px on their shortest side get the metadata only (Kokon does not make
them).

## Layer 1: metadata

An XMP packet in every PNG (`iTXt` `XML:com.adobe.xmp`), JPEG (APP1), WebP (`XMP ` chunk), Ultra HDR
JPEG and PSD (image resource 1060):

```xml
<rdf:Description rdf:about=""
  xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
  Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
  xmp:CreatorTool="Kokon 0.12.0"
  xmp:CreateDate="2026-11-04T10:00:00+01:00"/>
```

The [IPTC Digital Source Type](https://cv.iptc.org/newscodes/digitalsourcetype/) is the term Google,
Meta, Adobe and others read to label AI images. It is not signed: Kokon runs on your own computer,
where a signing key could not be kept secret (the Code of Practice leaves signatures out "in a
local deployment scenario"). Metadata is easy to strip, so it is not the only mark.

Code: [crates/qls-core/src/provenance.rs](../crates/qls-core/src/provenance.rs),
[src/lib/psd.ts](../src/lib/psd.ts).

## Layer 2: invisible watermark

[TrustMark](https://github.com/adobe/trustmark) by Adobe, variant **P** (the high-quality one), MIT
licensed code and model weights. It is an open, documented watermark listed in the
[C2PA soft-binding algorithm list](https://github.com/c2pa-org/softbinding-algorithm-list)
(`com.adobe.trustmark.P`), so anyone can read it with Adobe's free decoder; no key is needed.

- **Payload:** the text `Kokon-AI`, in TrustMark's text mode (7-bit ASCII) with the `BCH_5` error
  correction (61 data bits, up to 5 wrong bits corrected). Nothing about you, your prompt or your
  computer is in it.
- **Where:** the largest centred square of the image, faded in over its outer 6 %. The alpha
  channel is never changed.
- **Strength:** TrustMark's default (1.0).
- **Once:** an image that already carries Kokon's mark (an edit of a Kokon result) is not marked
  again.
- **Models:** `encoder_P.onnx` and `decoder_P.onnx` from Adobe, included in the installer (pinned by
  size and SHA-256 in [catalog.rs](../crates/qls-core/src/catalog.rs)).

Code: [crates/qls-core/src/watermark/](../crates/qls-core/src/watermark/), a port of Adobe's Python
reference on Kokon's ONNX Runtime.

## Check an image

- **In Kokon:** Settings → General → AI marking → **Check an image**. It reads the metadata (and
  whether a C2PA manifest is present, without verifying it) and the watermark, and says what they
  mean. The image is read on the computer running Kokon and not kept. **Copy report** gives the
  result with the file's SHA-256, the time and the checker's version.
- **Through the API:** `POST /api/v1/provenance/check` with the image bytes as the body (see
  [http-api.md](http-api.md)).
- **With Adobe's decoder**, without Kokon:

  ```python
  # pip install trustmark
  from PIL import Image
  from trustmark import TrustMark
  tm = TrustMark(model_type="P")
  print(tm.decode(Image.open("image.png").convert("RGB")))
  # ('Kokon-AI', True, 1): Kokon's mark, found, schema BCH_5
  ```

- **The metadata** with any XMP reader, e.g. `exiftool -XMP-iptcExt:DigitalSourceType image.png`.

## How well it works

Measured on 2026-11-04 with
[examples/watermark_check.rs](../crates/qls-core/examples/watermark_check.rs) (`bench` and
`negatives`), on 33 Kokon results from 1024×1024 to 5504×3072 (photos, illustrations, edits,
expansions). Kokon's mark and Adobe's Python reference read each other's marks.

**Visibility:** PSNR 49.0 dB at worst, 51.6 dB median (above ~45 dB a change is not visible); the
largest change to any pixel is 17 of 255 levels, in detailed areas. Compared side by side at 100 %,
flat colour included, no difference was visible. Marking takes about 0.1 s (0.36 s for a
5504×3072 image) on the CPU.

**Read back after** (out of 33):

| Change | Read |
|---|---|
| None (PNG) | 33 |
| JPEG quality 90 / 75 / 50 | 32 / 32 / 30 |
| Half size / quarter size / 1.5× size | 33 / 33 / 33 |
| Screenshot-like (75 % size, JPEG 85) | 32 |
| Crop 10 % / 20 % of the area (right and bottom) | 33 / 33 |
| Brightness +10 %, noise ±6 levels, blur, mirror | 33 each |

The one image that lost the mark after JPEG compression is mostly flat purple: there is little
texture to hold it. Its metadata still marks it.

**False alarms:** none. Of 1,567 unmarked images (Kokon results made before the watermark,
older AI images, screenshots, game captures), none was read as Kokon's mark. Kokon's mark is
accepted only with exactly its text and error-correction schema; a random 100-bit pattern lands
within 5 bits of it about once in 10²¹ reads. (TrustMark's weaker schemas accept about 2 % of unmarked
images as *some* watermark, with random text, so "Check an image" names another app's TrustMark
only when it uses the strongest schema.)

**Limits:** like every watermark, it can be removed on purpose (for example by regenerating the
image with another model), and a large crop that cuts away the centre removes it. A file that
lost both marks cannot be told apart from any other image.

## Our process

Before each release that changes how images are written, we run the tests above and the unit
tests in `watermark/` and `provenance.rs` (a marked image is read back after JPEG and resizing;
random bits are never read as Kokon's mark). Reports of a mark that is missing, visible or misread
are welcome as [issues](https://github.com/GabrieleLozupone/kokon/issues).
