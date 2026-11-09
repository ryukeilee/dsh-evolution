"""Real-tokenizer probe for the fixed model context of two registration sources.

Each run starts one isolated Pi session with a tiny fixed prompt that calls no
tool. The provider-reported `usage.input` of the first assistant message is the
whole request: provider wrapper + system prompt + tool definitions + prompt. The
prompt, provider, model, thinking level, host flags and process environment are
identical on both sides, so the A/B difference isolates the fixed context. A
control phase runs the baseline source twice to show the measurement is stable.

No credential is read or exported; Pi must already be signed in for the free
catalog model. Cost fields are catalog values for a free model, not an invoice.

Usage:
  python3 token-probe.py <baseline-repo> <candidate-repo> <out-dir> [pairs] [control-pairs]
"""
import json,os,pathlib,subprocess,sys,tempfile,time

PROMPT = "Reply with the single word OK. Do not call any tool."
HERE = pathlib.Path(__file__).resolve().parent

def capture(repo):
    fixture = pathlib.Path(repo) / 'scripts/benchmarks/fixed-context/fixture.mjs'
    with tempfile.TemporaryDirectory(prefix='evolution-token-capture-') as cap:
        return json.loads(subprocess.check_output(
            ['node', '--max-old-space-size=4096', str(fixture), '--capture', cap], text=True))

def composition(base):
    """Byte accounting over the captured registration, same envelope as axis-token-audit."""
    b = lambda value: len(value.encode('utf-8'))
    tools = [dict(name=t['name'], nameBytes=b(t['name']), descriptionBytes=b(t['description']),
                  parametersJsonBytes=b(json.dumps(t['parameters'], separators=(',', ':'), ensure_ascii=False)))
             for t in base['tools']]
    wire = json.dumps([dict(name=t['name'], description=t['description'], parameters=t['parameters']) for t in base['tools']],
                      separators=(',', ':'), ensure_ascii=False)
    fields = b(base['system']) + sum(t['nameBytes'] + t['descriptionBytes'] + t['parametersJsonBytes'] for t in tools)
    normalized = b(base['system']) + b(wire)
    return dict(systemBytes=b(base['system']), tools=tools,
                descriptionBytes=sum(t['descriptionBytes'] for t in tools),
                parametersJsonBytes=sum(t['parametersJsonBytes'] for t in tools),
                fieldsBytes=fields, normalizedToolsArrayBytes=b(wire), normalizedBytes=normalized,
                fieldsTokensEstimated=round(fields / 3.6, 1), normalizedTokensEstimated=round(normalized / 3.6, 1),
                note='UTF-8 bytes measured; /3.6 token estimate is an assumption, not a tokenizer count or invoice')

def run(repo, dest, side, phase):
    dest = pathlib.Path(dest); dest.mkdir(parents=True, exist_ok=False)
    base = capture(repo)
    comp = composition(base)
    (dest / 'system.txt').write_text(base['system'])
    (dest / 'registered.json').write_text(json.dumps({'system': base['system'], 'tools': base['tools']}, indent=2))
    env = dict(os.environ)
    env['EVOLUTION_FREE_RUN'] = str(dest)
    env['NODE_OPTIONS'] = '--max-old-space-size=4096'
    cmd = ['pi', '--provider', 'opencode-go', '--model', 'opencode-go/beam-free', '--thinking', 'low',
           '--system-prompt', base['system'], '--no-session', '--session-dir', str(dest / 'sessions'),
           '--mode', 'json', '-p', '--no-builtin-tools', '--no-extensions',
           '--extension', str(pathlib.Path(repo) / 'scripts/benchmarks/fixed-context/pi-extension.mjs'),
           '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', PROMPT]
    start = time.monotonic()
    with open(dest / 'events.jsonl', 'w') as out, open(dest / 'stderr', 'w') as err:
        try:
            code = subprocess.run(cmd, cwd=dest, env=env, stdout=out, stderr=err, timeout=180).returncode
        except subprocess.TimeoutExpired:
            code = 'timeout'
    events = [json.loads(x) for x in (dest / 'events.jsonl').read_text().splitlines() if x.strip()]
    usage = [x['message']['usage'] for x in events
             if x.get('type') == 'message_end' and x.get('message', {}).get('role') == 'assistant' and x['message'].get('usage')]
    trace = [json.loads(x) for x in (dest / 'trace.jsonl').read_text().splitlines() if x.strip()] if (dest / 'trace.jsonl').exists() else []
    requests = [x['payload'] for x in trace if x['kind'] == 'request']
    registry = (dest / 'registered.json').read_text()
    problems = []
    if code != 0 or not usage:
        problems.append(f'exit {code} without usage')
    if not requests:
        problems.append('no captured provider request')
    else:
        if requests[0]['messages'][0]['content'] != base['system'] + '\n\n<cwd>\n' + str(dest.resolve()) + '\n</cwd>':
            problems.append('first request system text does not match the captured registration')
        wire = [dict(name=t['function']['name'], description=t['function']['description'], parameters=t['function']['parameters'])
                for t in requests[0]['tools']]
        if json.dumps(wire, sort_keys=True) != json.dumps(base['tools'], sort_keys=True):
            problems.append('first request tool definitions do not match the captured registration')
    first = usage[0] if usage else None
    # Provider prompt caching moves prefix tokens from `input` into `cacheRead`.
    # The tokenizer count of the whole request is their sum; comparing raw
    # `input` alone would make a cache hit look like a smaller prompt.
    total_input = (first['input'] + first['cacheRead'] + first['cacheWrite']) if first else None
    record = {'phase': phase, 'side': side, 'repo': str(repo), 'exit': code, 'elapsedSeconds': round(time.monotonic() - start, 2),
              'model': 'opencode-go/beam-free', 'thinking': 'low', 'prompt': PROMPT,
              'requests': len(requests), 'payloadBytes': [len(json.dumps(r, ensure_ascii=False, separators=(',', ':')).encode()) for r in requests],
              'firstRequestInputTokens': first['input'] if first else None,
              'firstRequestCacheRead': first['cacheRead'] if first else None,
              'firstRequestCacheWrite': first['cacheWrite'] if first else None,
              'firstRequestTotalInputTokens': total_input,
              'composition': comp, 'usage': usage, 'problems': problems}
    (dest / 'run.json').write_text(json.dumps(record, indent=2))
    print(json.dumps({'side': side, 'totalInput': record['firstRequestTotalInputTokens'], 'input': record['firstRequestInputTokens'],
                      'cacheRead': record['firstRequestCacheRead'], 'payloadBytes': record['payloadBytes'][:1],
                      'problems': problems}), flush=True)
    return record

def main():
    if len(sys.argv) < 4: raise SystemExit(__doc__)
    baseline, candidate, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    pairs = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    controls = int(sys.argv[5]) if len(sys.argv) > 5 else 2
    out.mkdir(parents=True, exist_ok=False)
    runs = []
    for pair in range(1, pairs + 1):
        order = ['A', 'B'] if pair % 2 == 1 else ['B', 'A']
        repos = {'A': baseline, 'B': candidate}
        for label in order:
            runs.append(run(repos[label], out / f'ab-{pair:02d}-{label}', label, 'ab'))
    for pair in range(1, controls + 1):
        order = ['A', 'B'] if pair % 2 == 1 else ['B', 'A']
        for label in order:
            runs.append(run(baseline, out / f'aa-{pair:02d}-{label}', label, 'aa'))
    # Every ab-*-A folder used the baseline repo and every ab-*-B folder the
    # candidate repo; aa-* folders are the base/base control phase.
    ab_a = [json.loads(p.read_text())['firstRequestTotalInputTokens'] for p in sorted(out.glob('ab-*-A/run.json'))]
    ab_b = [json.loads(p.read_text())['firstRequestTotalInputTokens'] for p in sorted(out.glob('ab-*-B/run.json'))]
    aa = [json.loads(p.read_text())['firstRequestTotalInputTokens'] for p in sorted(out.glob('aa-*/run.json'))]
    summary = {
        'method': 'first assistant usage.input+cacheRead+cacheWrite from Pi JSON events; identical tiny prompt and model flags on both sides',
        'model': 'opencode-go/beam-free', 'thinking': 'low', 'prompt': PROMPT,
        'ab': {'baseline': ab_a, 'candidate': ab_b,
               'deltaTokensEachPair': [a - b for a, b in zip(ab_a, ab_b)],
               'reductionPercentOfBaseline': [round((a - b) / a * 100, 2) for a, b in zip(ab_a, ab_b)]},
        'aa': {'inputs': aa, 'pairDeltas': [aa[i] - aa[i + 1] for i in range(0, len(aa) - 1, 2)]},
        'composition': {side: next(r['composition'] for r in runs
                                   if r['phase'] == 'ab' and r['side'] == side) for side in ['A', 'B']},
        'runs': runs,
        'boundaries': ['free catalog model; provider-reported tokens, no invoice paid',
                       'the delta isolates provider wrapper + system prompt + tool definitions + prompt',
                       'a session may send more requests; only the first request is measured'],
    }
    baseline_comp, candidate_comp = summary['composition']['A'], summary['composition']['B']
    summary['composition']['reduction'] = {
        'fieldsBytes': baseline_comp['fieldsBytes'] - candidate_comp['fieldsBytes'],
        'fieldsPercent': round((baseline_comp['fieldsBytes'] - candidate_comp['fieldsBytes']) / baseline_comp['fieldsBytes'] * 100, 2),
        'normalizedBytes': baseline_comp['normalizedBytes'] - candidate_comp['normalizedBytes'],
        'normalizedPercent': round((baseline_comp['normalizedBytes'] - candidate_comp['normalizedBytes']) / baseline_comp['normalizedBytes'] * 100, 2),
        'systemBytes': baseline_comp['systemBytes'] - candidate_comp['systemBytes'],
        'descriptionBytes': baseline_comp['descriptionBytes'] - candidate_comp['descriptionBytes'],
        'parametersJsonBytes': baseline_comp['parametersJsonBytes'] - candidate_comp['parametersJsonBytes'],
    }
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary['ab'], indent=2))
    bad = [r for r in runs if r['problems']]
    if bad:
        print(json.dumps(bad, indent=2)); sys.exit(1)

if __name__ == '__main__':
    main()
