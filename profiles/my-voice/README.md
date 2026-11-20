# Personal voice profile

Use the [calibration skill](skills/my-voice-calibrate/SKILL.md) to review writing samples, set communication preferences and prepare a local profile. No local history is read unless you select it. You can use just samples you provide or an explicitly supplied source report.

Select the private profile's `SKILL.md` in your host to apply it. It guides assistant replies by default and applies to writing in your voice only on request. It cannot change permissions, factual claims or authorship. See the [command reference](skills/my-voice-calibrate/references/calibration.md) for the standalone entry points and runtime.

From the repository root, run the synthetic test suite without reading any account or history. Cursor discovery uses a fabricated environment; the other Cursor tests pass fixture roots explicitly.

```sh
python3 -B -m unittest discover -s profiles/my-voice/tests -v
```
