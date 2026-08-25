import { TranscribeAPI, handleFailure } from '../api';
import { getConfig } from '../config';

function apiFor(argv: any): TranscribeAPI {
  return new TranscribeAPI(getConfig({ allowCustomHost: argv.allowCustomHost }));
}

// The ONE non-JSON command: prints the raw subtitle body (SRT/VTT/JSON)
// so it can be piped straight to a file. Errors keep the JSON envelope.
export async function subtitles(argv: any): Promise<void> {
  try {
    const raw = await apiFor(argv).requestRaw(
      `/transcriptions/${argv.id}/subtitles`,
      {
        format: argv.format,
        preset: argv.preset,
        speaker_labels: argv.speakerLabels ? true : undefined,
        mode: argv.mode,
        source: argv.source,
      }
    );
    process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
  } catch (err) {
    handleFailure(err);
  }
}

export async function ask(argv: any): Promise<void> {
  try {
    const body: Record<string, unknown> = { question: argv.question };
    if (argv.topK !== undefined) body.top_k = argv.topK;
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/ask`, {
      method: 'POST',
      body,
    });
    process.stdout.write(res.rawText.endsWith('\n') ? res.rawText : res.rawText + '\n');
  } catch (err) {
    handleFailure(err);
  }
}
