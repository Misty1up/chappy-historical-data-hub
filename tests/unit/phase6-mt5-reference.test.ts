import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ingestPhase6Mt5TraceJsonl,
  parsePhase6Mt5TraceJsonl,
} from '../../src/parity/mt5-reference-trace.js';
import {
  phase6TraceRootSha256,
  type Phase6TraceEvent,
} from '../../src/parity/trace-contract.js';

const fixturePath = resolve(process.cwd(), 'tests', 'fixtures', 'phase6-numba-reference-trace.json');
const mt5SourcePath = resolve(process.cwd(), 'mt5', 'HDH_Phase6_Reference_Probe.mq5');
const reportSchemaPath = resolve(process.cwd(), 'schemas', 'phase6_mt5_trace_report.schema.json');

function mt5Fixture(): Phase6TraceEvent[] {
  const numba = JSON.parse(readFileSync(fixturePath, 'utf8')) as Phase6TraceEvent[];
  return numba.map(event => ({ ...event, engine: 'MT5' as const }));
}

test('P6.4 MT5 JSONL ingest accepts the P6_REFERENCE_PARITY_PROBE_V1 synthetic trace', () => {
  const events = mt5Fixture();
  const jsonl = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  const summary = ingestPhase6Mt5TraceJsonl(jsonl);

  assert.equal(summary.trace_event_count, 23);
  assert.deepEqual(summary.layer_counts, {
    INPUT: 9,
    INDICATOR_FEATURE: 9,
    SIGNAL: 1,
    EXECUTION: 2,
    RESULT: 2,
  });
  assert.equal(summary.trace_root_sha256, 'e08c17bb2023541327ed9e380d32e83787f42554f43d82926472b395bf9ff027');
  assert.equal(summary.trace_root_sha256, phase6TraceRootSha256(events));
});

test('P6.4 MT5 JSONL ingest rejects a NUMBA engine event stream', () => {
  const text = readFileSync(fixturePath, 'utf8');
  const events = JSON.parse(text) as Phase6TraceEvent[];
  const jsonl = events.map(event => JSON.stringify(event)).join('\n');
  assert.throws(() => parsePhase6Mt5TraceJsonl(jsonl), /MT5/);
});

test('P6.4 generic MQL5 adapter is tester-only and contains no terminal mutation or trade API', () => {
  const source = readFileSync(mt5SourcePath, 'utf8');

  for (const required of [
    'MQL_TESTER',
    'SYMBOL_CUSTOM',
    'FILE_COMMON',
    'OnTick',
    'OnTester',
    'P6_REFERENCE_PARITY_PROBE_V1',
    'SPREAD_SCALED_V1',
    'ORDINAL_MOD_1024_SPREAD_PARITY_V1',
    'ZERO_BASED_PER_UTC_DAY_FROM_ACCEPTED_MT5_ROW_ORDER',
    'cb8fc63ce168100cede8e8475ef6f67dedde19fd1bc02ff51ff5b50b91d0a23b',
  ]) {
    assert.equal(source.includes(required), true, `missing required P6.4 token: ${required}`);
  }

  for (const forbidden of [
    'CustomSymbolCreate',
    'CustomTicksReplace',
    'CustomSymbolSet',
    'OrderSend',
    'OrderSendAsync',
    'CTrade',
  ]) {
    assert.equal(source.includes(forbidden), false, `P6.4 adapter must not contain ${forbidden}`);
  }
});

test('P6.4 compact MT5 report schema freezes non-mutation evidence', () => {
  const schema = JSON.parse(readFileSync(reportSchemaPath, 'utf8')) as {
    properties: Record<string, { const?: unknown }>;
  };
  assert.equal(schema.properties.report_schema_version?.const, 'HDH_P6_MT5_TRACE_REPORT_V1');
  assert.equal(schema.properties.adapter_version?.const, 'P6_MT5_REFERENCE_ADAPTER_V1');
  assert.equal(schema.properties.logic_contract_sha256?.const, 'cb8fc63ce168100cede8e8475ef6f67dedde19fd1bc02ff51ff5b50b91d0a23b');
  assert.equal(schema.properties.trace_root_status?.const, 'COMPUTE_AFTER_INGEST');
  assert.equal(schema.properties.input_mutation?.const, false);
  assert.equal(schema.properties.canonical_reorder?.const, false);
  assert.equal(schema.properties.source_reacquisition?.const, false);
  assert.equal(schema.properties.automatic_terminal_mutation?.const, false);
  assert.equal(schema.properties.real_account_execution?.const, false);
});
