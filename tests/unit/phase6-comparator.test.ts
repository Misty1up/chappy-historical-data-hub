import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhase6ComparatorProfile, Phase6ComparatorProfileError } from '../../src/parity/comparator-profile.js';
import { comparePhase6Traces } from '../../src/parity/comparator.js';
import { buildPhase6ParitySummary } from '../../src/parity/summary.js';
import { phase6TraceRootSha256, Phase6TraceError, type Phase6ParityLayer, type Phase6TraceEvent } from '../../src/parity/trace-contract.js';

const RUN = `HDH_P6_RUN_V1_${'1'.repeat(64)}`;
function event(engine: 'NUMBA' | 'MT5', layer: Phase6ParityLayer, eventSeq: number, ordinal: number | null, fields: Record<string, any> = {}): Phase6TraceEvent {
  return {
    trace_schema_version: 'HDH_P6_TRACE_EVENT_V1', parity_run_id: RUN, engine, layer, event_seq: eventSeq,
    canonical_ordinal: ordinal, timestamp_msc: ordinal === null ? null : 1760000000000 + ordinal,
    bar_seq: layer === 'INDICATOR_FEATURE' ? eventSeq : null,
    signal_seq: layer === 'SIGNAL' ? eventSeq : null,
    intent_seq: layer === 'EXECUTION' ? eventSeq : null,
    parity_trade_id: layer === 'EXECUTION' || layer === 'RESULT' ? `T${eventSeq}` : null,
    fields,
  };
}
function pair(events: Array<[Phase6ParityLayer, number, number | null, Record<string, any>]>) {
  return {
    n: events.map(([l,s,o,f]) => event('NUMBA', l,s,o,f)),
    m: events.map(([l,s,o,f]) => event('MT5', l,s,o,structuredClone(f))),
  };
}
const exact = () => createPhase6ComparatorProfile('P6_EXACT_V1', []);

test('P6.2 identical normalized traces PASS with deterministic compact summary', () => {
  const {n,m} = pair([['INPUT',0,0,{bid_scaled:110000,ask_scaled:110002}],['INDICATOR_FEATURE',0,1,{ema:1.1}],['SIGNAL',0,1,{eligible:true}],['EXECUTION',0,2,{price_scaled:110003}],['RESULT',0,2,{pnl:3}]]);
  const profile = exact();
  const result = comparePhase6Traces(n,m,profile);
  assert.equal(result.status,'PASS'); assert.equal(result.first_divergence,null);
  const a = buildPhase6ParitySummary(result,n,m,profile); const b = buildPhase6ParitySummary(result,n,m,profile);
  assert.deepEqual(a,b); assert.equal(a.status,'PASS'); assert.equal(a.mismatch_count_total,0);
  assert.equal(a.numba_trace_root_sha256, phase6TraceRootSha256(n));
});

test('P6.2 run identity mismatch is INPUT divergence at run start', () => {
  const {n,m}=pair([['INPUT',0,0,{x:1}]]); m[0]!.parity_run_id=`HDH_P6_RUN_V1_${'2'.repeat(64)}`;
  const result=comparePhase6Traces(n,m,exact());
  assert.equal(result.first_divergence?.layer,'INPUT'); assert.equal(result.first_divergence?.field_path,'parity_run_id'); assert.equal(result.first_divergence?.canonical_ordinal,null);
});

test('P6.2 FIRST DIVERGENCE prioritizes earliest canonical ordinal before layer', () => {
  const {n,m}=pair([['INPUT',0,5,{a:1}],['RESULT',0,2,{z:1}]]); n[0]!.fields.a=2; n[1]!.fields.z=2;
  const result=comparePhase6Traces(n,m,exact());
  assert.equal(result.first_divergence?.canonical_ordinal,2); assert.equal(result.first_divergence?.layer,'RESULT');
});

test('P6.2 FIRST DIVERGENCE uses layer precedence then event sequence then field lexical order', () => {
  const {n,m}=pair([['RESULT',0,7,{a:1}],['SIGNAL',1,7,{z:1,a:1}],['SIGNAL',0,7,{z:1,a:1}],['INPUT',0,7,{z:1}]]);
  for (const e of n) for (const k of Object.keys(e.fields)) e.fields[k]=2;
  const n2=[n[0]!,n[2]!,n[1]!,n[3]!]; const m2=[m[0]!,m[2]!,m[1]!,m[3]!];
  const result=comparePhase6Traces(n2,m2,exact());
  assert.equal(result.first_divergence?.layer,'INPUT');
  const {n:sn,m:sm}=pair([['SIGNAL',0,7,{z:1,a:1}],['SIGNAL',1,7,{z:1,a:1}]]); for(const e of sn) for(const k of Object.keys(e.fields)) e.fields[k]=2;
  const s=comparePhase6Traces(sn,sm,exact()); assert.equal(s.first_divergence?.event_seq,0); assert.equal(s.first_divergence?.field_path,'fields.a');
});

test('P6.2 missing event is reported at its first event identity', () => {
  const {n,m}=pair([['INPUT',0,0,{x:1}],['SIGNAL',0,4,{x:1}],['SIGNAL',1,5,{x:1}]]); m.splice(1,1);
  const result=comparePhase6Traces(n,m,exact());
  assert.equal(result.first_divergence?.layer,'SIGNAL'); assert.equal(result.first_divergence?.event_seq,0); assert.equal(result.first_divergence?.field_path,'$event');
  assert.deepEqual(result.first_divergence?.previous_matching_checkpoint,{layer:'INPUT',event_seq:0,canonical_ordinal:0,timestamp_msc:1760000000000});
});

test('P6.2 declared absolute tolerance can pass eligible derived numeric field', () => {
  const {n,m}=pair([['INDICATOR_FEATURE',0,3,{ema:1.0004}]]); m[0]!.fields.ema=1.0;
  const profile=createPhase6ComparatorProfile('FLOAT_V1',[{layer:'INDICATOR_FEATURE',field_path:'fields.ema',comparator:'ABSOLUTE',abs_tolerance:0.001,units:'price',rationale:'predeclared floating implementation bound'}]);
  assert.equal(comparePhase6Traces(n,m,profile).status,'PASS');
  n[0]!.fields.ema=1.01; assert.equal(comparePhase6Traces(n,m,profile).status,'FAIL');
});

test('P6.2 undeclared derived numeric difference remains exact mismatch', () => {
  const {n,m}=pair([['INDICATOR_FEATURE',0,3,{ema:1.0000001}]]); m[0]!.fields.ema=1;
  assert.equal(comparePhase6Traces(n,m,exact()).status,'FAIL');
});

test('P6.2 rejects tolerance for authority/identity paths and wildcard/global rules', () => {
  for(const path of ['fields.bid_scaled','fields.dataset_id','fields.trade_id','fields.*']) {
    assert.throws(()=>createPhase6ComparatorProfile('BAD',[{layer:'INPUT',field_path:path,comparator:'ABSOLUTE',abs_tolerance:1,units:'x',rationale:'bad'}]), (e:any)=>e instanceof Phase6ComparatorProfileError);
  }
});

test('P6.2 rejects tolerant rules outside derived feature/result layers', () => {
  for (const layer of ['INPUT','SIGNAL','EXECUTION'] as const) {
    assert.throws(() => createPhase6ComparatorProfile('BAD_LAYER', [{ layer, field_path:'fields.synthetic_float', comparator:'ABSOLUTE', abs_tolerance:0.1, units:'u', rationale:'not allowed outside derived feature/result' }]), (e:any) => e instanceof Phase6ComparatorProfileError);
  }
});

test('P6.2 tolerant comparator never treats boolean/string mismatch as numeric tolerance PASS', () => {
  const {n,m}=pair([['INDICATOR_FEATURE',0,3,{feature_state:'A'}]]); m[0]!.fields.feature_state='B';
  const p=createPhase6ComparatorProfile('TYPE_V1',[{layer:'INDICATOR_FEATURE',field_path:'fields.feature_state',comparator:'ABSOLUTE',abs_tolerance:1,units:'state',rationale:'synthetic rejection check'}]);
  assert.equal(comparePhase6Traces(n,m,p).status,'FAIL');
});

test('P6.2 comparator profile hash is order-normalized and changes with policy', () => {
  const a=createPhase6ComparatorProfile('P',[{layer:'RESULT',field_path:'fields.pnl',comparator:'ABSOLUTE',abs_tolerance:0.1,units:'u',rationale:'r'},{layer:'INDICATOR_FEATURE',field_path:'fields.x',comparator:'RELATIVE',rel_tolerance:0.01,units:'u',rationale:'r'}]);
  const b=createPhase6ComparatorProfile('P',[...a.rules].reverse()); assert.equal(a.comparator_profile_sha256,b.comparator_profile_sha256);
  const c=createPhase6ComparatorProfile('P',[{...a.rules[0]!,abs_tolerance:0.2},a.rules[1]!]); assert.notEqual(a.comparator_profile_sha256,c.comparator_profile_sha256);
});

test('P6.2 trace validation rejects duplicate/out-of-order event sequence without sorting repair', () => {
  const {n}=pair([['INPUT',0,0,{x:1}],['INPUT',1,1,{x:1}]]); n[1]!.event_seq=0;
  assert.throws(()=>phase6TraceRootSha256(n),(e:any)=>e instanceof Phase6TraceError);
});
