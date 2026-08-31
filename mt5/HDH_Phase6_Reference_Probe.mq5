#property strict
#property version "1.00"

input string InpParityRunId = "";
input string InpDatasetId = "";
input string InpSourceHashRoot = "";
input string InpCanonicalLogicalHashRoot = "";
input string InpParquetFileHashRoot = "";
input string InpMt5DerivativeHashRoot = "";
input string InpCanonicalSymbol = "";
input string InpLogicContractSha256 = "";
input string InpBoundMt5AdapterVersion = "P6_MT5_REFERENCE_ADAPTER_V1";
input long InpExpectedTickCount = 0;
input long InpExpectedFirstTimeMsc = 0;
input long InpExpectedLastTimeMsc = 0;
input int InpPriceDigits = 0;
input long InpPriceScale = 0;
input string InpOutputStem = "hdh_p6_mt5_reference";

#define P6_TRACE_SCHEMA_VERSION "HDH_P6_TRACE_EVENT_V1"
#define P6_MT5_ADAPTER_VERSION "P6_MT5_REFERENCE_ADAPTER_V1"
#define P6_PROBE_ID "P6_REFERENCE_PARITY_PROBE_V1"
#define P6_PROBE_VERSION "1.0.0"
#define P6_PROBE_CONTRACT_SHA256 "cb8fc63ce168100cede8e8475ef6f67dedde19fd1bc02ff51ff5b50b91d0a23b"
#define P6_MT5_REPORT_SCHEMA_VERSION "HDH_P6_MT5_TRACE_REPORT_V1"
#define P6_TRACE_FORMAT "JSONL_EVENT_PER_LINE_V1"
#define P6_SOURCE_SEQ_BRIDGE "ZERO_BASED_PER_UTC_DAY_FROM_ACCEPTED_MT5_ROW_ORDER"
#define P6_SIGNAL_MODULUS 1024
#define P6_ENTRY_OFFSET 1
#define P6_EXIT_OFFSET 8

int g_trace_handle = INVALID_HANDLE;
string g_trace_name = "";
string g_report_name = "";
bool g_failed = false;
string g_failure_code = "";
string g_failure_message = "";

long g_tick_count = 0;
long g_first_time_msc = -1;
long g_last_time_msc = -1;
long g_current_utc_day = -1;
long g_source_seq_in_day = -1;

long g_input_seq = 0;
long g_feature_seq = 0;
long g_signal_seq_count = 0;
long g_execution_seq = 0;
long g_result_seq = 0;

long g_trade_count = 0;
long g_total_pnl_scaled = 0;

bool g_trade_active = false;
long g_active_signal_seq = -1;
long g_active_signal_ordinal = -1;
long g_active_entry_ordinal = -1;
long g_active_exit_ordinal = -1;
long g_active_entry_price_scaled = 0;
bool g_entry_captured = false;
string g_active_side = "";
string g_active_trade_id = "";

string JsonEscape(const string value)
{
   string out = "";
   const int length = StringLen(value);
   for(int i = 0; i < length; i++)
   {
      const ushort ch = StringGetCharacter(value, i);
      if(ch == 34) out += "\\\"";
      else if(ch == 92) out += "\\\\";
      else if(ch == 8) out += "\\b";
      else if(ch == 9) out += "\\t";
      else if(ch == 10) out += "\\n";
      else if(ch == 12) out += "\\f";
      else if(ch == 13) out += "\\r";
      else if(ch < 32) out += StringFormat("\\u%04x", (int)ch);
      else out += ShortToString(ch);
   }
   return out;
}

string JStr(const string value)
{
   return "\"" + JsonEscape(value) + "\"";
}

string JLong(const long value)
{
   return IntegerToString(value);
}

string JNull()
{
   return "null";
}

void Fail(const string code, const string message)
{
   if(g_failed)
      return;
   g_failed = true;
   g_failure_code = code;
   g_failure_message = message;
   PrintFormat("HDH P6.4 HOLD code=%s message=%s", code, message);
}

bool IsLowerHex64(const string value)
{
   if(StringLen(value) != 64)
      return false;
   for(int i = 0; i < 64; i++)
   {
      const string ch = StringSubstr(value, i, 1);
      if(StringFind("0123456789abcdef", ch) < 0)
         return false;
   }
   return true;
}

bool HasPrefixedHash(const string value, const string prefix)
{
   if(StringFind(value, prefix) != 0)
      return false;
   return IsLowerHex64(StringSubstr(value, StringLen(prefix)));
}

bool IsSafeOutputStem(const string value)
{
   if(StringLen(value) < 1 || StringLen(value) > 96)
      return false;
   for(int i = 0; i < StringLen(value); i++)
   {
      const string ch = StringSubstr(value, i, 1);
      if(StringFind("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", ch) < 0)
         return false;
   }
   return true;
}

long ExpectedScaleFromDigits(const int digits)
{
   if(digits < 0 || digits > 9)
      return -1;
   long scale = 1;
   for(int i = 0; i < digits; i++)
      scale *= 10;
   return scale;
}

bool DecimalTextToScaled(const string text, const int digits, const long scale, long &scaled)
{
   if(StringLen(text) == 0 || StringSubstr(text, 0, 1) == "-")
      return false;

   int dot = StringFind(text, ".");
   string whole = text;
   string frac = "";
   if(dot >= 0)
   {
      whole = StringSubstr(text, 0, dot);
      frac = StringSubstr(text, dot + 1);
   }

   if(whole == "")
      whole = "0";
   if(StringLen(frac) != digits)
      return false;

   for(int i = 0; i < StringLen(whole); i++)
      if(StringFind("0123456789", StringSubstr(whole, i, 1)) < 0)
         return false;
   for(int i = 0; i < StringLen(frac); i++)
      if(StringFind("0123456789", StringSubstr(frac, i, 1)) < 0)
         return false;

   const long whole_value = StringToInteger(whole);
   const long frac_value = (digits == 0 ? 0 : StringToInteger(frac));
   if(whole_value > LONG_MAX / scale)
      return false;

   scaled = whole_value * scale + frac_value;
   return true;
}

bool PriceToScaledExact(const double price, long &scaled)
{
   if(!(price > 0.0))
      return false;
   const string text = DoubleToString(price, InpPriceDigits);
   if(!DecimalTextToScaled(text, InpPriceDigits, InpPriceScale, scaled))
      return false;
   const double roundtrip = (double)scaled / (double)InpPriceScale;
   return DoubleToString(roundtrip, InpPriceDigits) == text;
}

string TradeId(const long index)
{
   return StringFormat("P6_REF_TRADE_%08I64d", index);
}

bool WriteTraceLine(const string line)
{
   if(g_trace_handle == INVALID_HANDLE)
   {
      Fail("P6_MT5_TRACE_NOT_OPEN", "trace handle is not open");
      return false;
   }
   const uint written = FileWriteString(g_trace_handle, line + "\n");
   if(written == 0)
   {
      Fail("P6_MT5_TRACE_WRITE_FAILED", "FileWriteString did not write the JSONL event");
      return false;
   }
   return true;
}

string EventJson(
   const string layer,
   const long event_seq,
   const long canonical_ordinal,
   const long timestamp_msc,
   const string bar_seq_json,
   const string signal_seq_json,
   const string intent_seq_json,
   const string parity_trade_id_json,
   const string fields_json
)
{
   string json = "{";
   json += "\"bar_seq\":" + bar_seq_json + ",";
   json += "\"canonical_ordinal\":" + JLong(canonical_ordinal) + ",";
   json += "\"engine\":\"MT5\",";
   json += "\"event_seq\":" + JLong(event_seq) + ",";
   json += "\"fields\":" + fields_json + ",";
   json += "\"intent_seq\":" + intent_seq_json + ",";
   json += "\"layer\":" + JStr(layer) + ",";
   json += "\"parity_run_id\":" + JStr(InpParityRunId) + ",";
   json += "\"parity_trade_id\":" + parity_trade_id_json + ",";
   json += "\"signal_seq\":" + signal_seq_json + ",";
   json += "\"timestamp_msc\":" + JLong(timestamp_msc) + ",";
   json += "\"trace_schema_version\":\"" + P6_TRACE_SCHEMA_VERSION + "\"";
   json += "}";
   return json;
}

bool EmitInput(
   const long ordinal,
   const long timestamp_msc,
   const long source_seq,
   const long bid_scaled,
   const long ask_scaled
)
{
   string fields = "{";
   fields += "\"ask_scaled\":" + JLong(ask_scaled) + ",";
   fields += "\"bid_scaled\":" + JLong(bid_scaled) + ",";
   fields += "\"price_scale\":" + JLong(InpPriceScale) + ",";
   fields += "\"source_seq\":" + JLong(source_seq);
   fields += "}";
   if(!WriteTraceLine(EventJson("INPUT", g_input_seq, ordinal, timestamp_msc, JNull(), JNull(), JNull(), JNull(), fields)))
      return false;
   g_input_seq++;
   return true;
}

bool EmitFeature(const long ordinal, const long timestamp_msc, const long spread_scaled)
{
   string fields = "{";
   fields += "\"feature_id\":\"SPREAD_SCALED_V1\",";
   fields += "\"spread_scaled\":" + JLong(spread_scaled);
   fields += "}";
   if(!WriteTraceLine(EventJson("INDICATOR_FEATURE", g_feature_seq, ordinal, timestamp_msc, JNull(), JNull(), JNull(), JNull(), fields)))
      return false;
   g_feature_seq++;
   return true;
}

bool EmitSignal(
   const long ordinal,
   const long timestamp_msc,
   const long signal_seq,
   const string side,
   const string trade_id,
   const long spread_scaled
)
{
   string fields = "{";
   fields += "\"eligible\":true,";
   fields += "\"entry_offset\":1,";
   fields += "\"exit_offset\":8,";
   fields += "\"side\":" + JStr(side) + ",";
   fields += "\"signal_rule\":\"ORDINAL_MOD_1024_SPREAD_PARITY_V1\",";
   fields += "\"spread_scaled\":" + JLong(spread_scaled);
   fields += "}";
   if(!WriteTraceLine(EventJson("SIGNAL", g_signal_seq_count, ordinal, timestamp_msc, JNull(), JLong(signal_seq), JNull(), JStr(trade_id), fields)))
      return false;
   g_signal_seq_count++;
   return true;
}

bool EmitExecution(
   const long ordinal,
   const long timestamp_msc,
   const long signal_seq,
   const long intent_seq,
   const string trade_id,
   const string action,
   const string side,
   const long signal_ordinal,
   const long price_scaled,
   const string price_side,
   const string execution_model
)
{
   string fields = "{";
   fields += "\"action\":" + JStr(action) + ",";
   fields += "\"execution_model\":" + JStr(execution_model) + ",";
   fields += "\"price_scaled\":" + JLong(price_scaled) + ",";
   fields += "\"price_side\":" + JStr(price_side) + ",";
   fields += "\"side\":" + JStr(side) + ",";
   fields += "\"signal_ordinal\":" + JLong(signal_ordinal);
   fields += "}";
   if(!WriteTraceLine(EventJson("EXECUTION", g_execution_seq, ordinal, timestamp_msc, JNull(), JLong(signal_seq), JLong(intent_seq), JStr(trade_id), fields)))
      return false;
   g_execution_seq++;
   return true;
}

bool EmitTradeResult(
   const long ordinal,
   const long timestamp_msc,
   const long signal_seq,
   const string trade_id,
   const string side,
   const long entry_price_scaled,
   const long exit_price_scaled,
   const long pnl_scaled
)
{
   string fields = "{";
   fields += "\"entry_price_scaled\":" + JLong(entry_price_scaled) + ",";
   fields += "\"exit_price_scaled\":" + JLong(exit_price_scaled) + ",";
   fields += "\"pnl_scaled\":" + JLong(pnl_scaled) + ",";
   fields += "\"result_type\":\"TRADE\",";
   fields += "\"side\":" + JStr(side);
   fields += "}";
   if(!WriteTraceLine(EventJson("RESULT", g_result_seq, ordinal, timestamp_msc, JNull(), JLong(signal_seq), JNull(), JStr(trade_id), fields)))
      return false;
   g_result_seq++;
   return true;
}

bool EmitAggregateResult()
{
   string fields = "{";
   fields += "\"result_type\":\"AGGREGATE\",";
   fields += "\"total_pnl_scaled\":" + JLong(g_total_pnl_scaled) + ",";
   fields += "\"trade_count\":" + JLong(g_trade_count);
   fields += "}";
   if(!WriteTraceLine(EventJson("RESULT", g_result_seq, g_tick_count - 1, g_last_time_msc, JNull(), JNull(), JNull(), JNull(), fields)))
      return false;
   g_result_seq++;
   return true;
}

long EventCountTotal()
{
   return g_input_seq + g_feature_seq + g_signal_seq_count + g_execution_seq + g_result_seq;
}

bool ValidateInputs()
{
   if(!HasPrefixedHash(InpParityRunId, "HDH_P6_RUN_V1_"))
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "parity_run_id must be HDH_P6_RUN_V1_<64 lowercase hex>");
      return false;
   }
   if(!HasPrefixedHash(InpDatasetId, "HDH_DATASET_V1_"))
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "dataset_id must be HDH_DATASET_V1_<64 lowercase hex>");
      return false;
   }
   if(!IsLowerHex64(InpSourceHashRoot) ||
      !IsLowerHex64(InpCanonicalLogicalHashRoot) ||
      !IsLowerHex64(InpParquetFileHashRoot) ||
      !IsLowerHex64(InpMt5DerivativeHashRoot))
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "all Phase 6 hash roots must be 64 lowercase hex");
      return false;
   }
   if(StringLen(InpCanonicalSymbol) == 0)
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "canonical symbol is required");
      return false;
   }
   if(InpBoundMt5AdapterVersion != P6_MT5_ADAPTER_VERSION)
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "bound mt5_adapter_version does not match this adapter");
      return false;
   }
   if(InpLogicContractSha256 != P6_PROBE_CONTRACT_SHA256)
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "logic_contract_sha256 does not match P6_REFERENCE_PARITY_PROBE_V1");
      return false;
   }
   if(InpExpectedTickCount < 1 ||
      InpExpectedFirstTimeMsc < 0 ||
      InpExpectedLastTimeMsc < InpExpectedFirstTimeMsc)
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "expected tick count/time bounds are invalid");
      return false;
   }
   const long expected_scale = ExpectedScaleFromDigits(InpPriceDigits);
   if(expected_scale < 1 || InpPriceScale != expected_scale)
   {
      Fail("P6_MT5_RUN_SPEC_INVALID", "price_scale must equal 10^price_digits");
      return false;
   }
   if(!IsSafeOutputStem(InpOutputStem))
   {
      Fail("P6_MT5_OUTPUT_INVALID", "output stem must be a safe basename");
      return false;
   }
   return true;
}

bool ValidateTesterTarget()
{
   if(MQLInfoInteger(MQL_TESTER) == 0)
   {
      Fail("P6_MT5_TESTER_REQUIRED", "reference adapter may run only inside MT5 Strategy Tester");
      return false;
   }

   long is_custom = 0;
   if(!SymbolInfoInteger(_Symbol, SYMBOL_CUSTOM, is_custom) || is_custom == 0)
   {
      Fail("P6_MT5_CUSTOM_SYMBOL_REQUIRED", "Strategy Tester target must be an isolated HDH custom symbol");
      return false;
   }

   long actual_digits = 0;
   double actual_point = 0.0;
   if(!SymbolInfoInteger(_Symbol, SYMBOL_DIGITS, actual_digits) ||
      !SymbolInfoDouble(_Symbol, SYMBOL_POINT, actual_point))
   {
      Fail("P6_MT5_SYMBOL_CONTRACT_UNAVAILABLE", "cannot read custom-symbol Digits/Point");
      return false;
   }
   if(actual_digits != InpPriceDigits)
   {
      Fail("P6_MT5_PRECISION_MISMATCH", "custom-symbol Digits differ from accepted run contract");
      return false;
   }
   const double expected_point = 1.0 / (double)InpPriceScale;
   if(DoubleToString(actual_point, InpPriceDigits) != DoubleToString(expected_point, InpPriceDigits))
   {
      Fail("P6_MT5_PRECISION_MISMATCH", "custom-symbol Point differs from accepted run contract");
      return false;
   }
   return true;
}

int OnInit()
{
   if(!ValidateInputs() || !ValidateTesterTarget())
      return INIT_FAILED;

   g_trace_name = InpOutputStem + ".mt5_trace.jsonl";
   g_report_name = InpOutputStem + ".mt5_trace_report.json";

   if(FileIsExist(g_trace_name, FILE_COMMON) || FileIsExist(g_report_name, FILE_COMMON))
   {
      Fail("P6_MT5_OUTPUT_EXISTS", "reference adapter refuses to overwrite existing local trace evidence");
      return INIT_FAILED;
   }

   ResetLastError();
   g_trace_handle = FileOpen(g_trace_name, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(g_trace_handle == INVALID_HANDLE)
   {
      Fail("P6_MT5_TRACE_OPEN_FAILED", "cannot open FILE_COMMON trace output");
      return INIT_FAILED;
   }

   PrintFormat(
      "HDH P6.4 START adapter=%s probe=%s symbol=%s expected_ticks=%I64d trace=%s",
      P6_MT5_ADAPTER_VERSION,
      P6_PROBE_ID,
      _Symbol,
      InpExpectedTickCount,
      g_trace_name
   );
   return INIT_SUCCEEDED;
}

void OnTick()
{
   if(g_failed || g_trace_handle == INVALID_HANDLE)
      return;
   if(g_tick_count >= InpExpectedTickCount)
   {
      Fail("P6_MT5_EXTRA_TICK", "Strategy Tester delivered more ticks than the bound run contract");
      return;
   }

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
   {
      Fail("P6_MT5_TICK_READ_FAILED", "SymbolInfoTick failed inside OnTick");
      return;
   }

   const long ordinal = g_tick_count;
   const long timestamp_msc = tick.time_msc;
   if(timestamp_msc < 0)
   {
      Fail("P6_MT5_TIMESTAMP_INVALID", "negative timestamp_msc is invalid");
      return;
   }
   if(ordinal == 0)
   {
      g_first_time_msc = timestamp_msc;
      if(timestamp_msc != InpExpectedFirstTimeMsc)
      {
         Fail("P6_MT5_FIRST_TIMESTAMP_MISMATCH", "first tester tick does not match bound first timestamp");
         return;
      }
   }
   else if(timestamp_msc < g_last_time_msc)
   {
      Fail("P6_MT5_ROW_REORDER", "tester timestamp decreased; sorting is forbidden");
      return;
   }

   long bid_scaled = 0;
   long ask_scaled = 0;
   if(!PriceToScaledExact(tick.bid, bid_scaled) || !PriceToScaledExact(tick.ask, ask_scaled))
   {
      Fail("P6_MT5_PRICE_LATTICE_MISMATCH", "Bid/Ask is not exactly representable on the accepted price scale");
      return;
   }
   if(ask_scaled < bid_scaled)
   {
      Fail("P6_MT5_NEGATIVE_SPREAD", "negative spread is invalid for the reference probe");
      return;
   }

   const long utc_day = timestamp_msc / 86400000;
   if(ordinal == 0 || utc_day != g_current_utc_day)
   {
      if(ordinal > 0 && utc_day < g_current_utc_day)
      {
         Fail("P6_MT5_UTC_DAY_REORDER", "UTC day decreased; row reorder is forbidden");
         return;
      }
      g_current_utc_day = utc_day;
      g_source_seq_in_day = 0;
   }
   else
   {
      g_source_seq_in_day++;
   }

   const long spread_scaled = ask_scaled - bid_scaled;

   if(!EmitInput(ordinal, timestamp_msc, g_source_seq_in_day, bid_scaled, ask_scaled))
      return;
   if(!EmitFeature(ordinal, timestamp_msc, spread_scaled))
      return;

   if(g_trade_active && ordinal == g_active_entry_ordinal)
   {
      g_active_entry_price_scaled = (g_active_side == "LONG" ? ask_scaled : bid_scaled);
      g_entry_captured = true;
      const string side_used = (g_active_side == "LONG" ? "ASK" : "BID");
      if(!EmitExecution(
         ordinal,
         timestamp_msc,
         g_active_signal_seq,
         2 * g_active_signal_seq,
         g_active_trade_id,
         "ENTRY",
         g_active_side,
         g_active_signal_ordinal,
         g_active_entry_price_scaled,
         side_used,
         "REFERENCE_MARKET_NEXT_TICK"
      ))
         return;
   }

   if(g_trade_active && ordinal == g_active_exit_ordinal)
   {
      if(!g_entry_captured)
      {
         Fail("P6_MT5_EXECUTION_STATE_INVALID", "exit reached without the bound entry event");
         return;
      }
      const long exit_price_scaled = (g_active_side == "LONG" ? bid_scaled : ask_scaled);
      const string side_used = (g_active_side == "LONG" ? "BID" : "ASK");
      if(!EmitExecution(
         ordinal,
         timestamp_msc,
         g_active_signal_seq,
         2 * g_active_signal_seq + 1,
         g_active_trade_id,
         "EXIT",
         g_active_side,
         g_active_signal_ordinal,
         exit_price_scaled,
         side_used,
         "REFERENCE_MARKET_FIXED_EXIT"
      ))
         return;

      const long pnl_scaled = (g_active_side == "LONG"
         ? exit_price_scaled - g_active_entry_price_scaled
         : g_active_entry_price_scaled - exit_price_scaled);
      g_total_pnl_scaled += pnl_scaled;
      if(!EmitTradeResult(
         ordinal,
         timestamp_msc,
         g_active_signal_seq,
         g_active_trade_id,
         g_active_side,
         g_active_entry_price_scaled,
         exit_price_scaled,
         pnl_scaled
      ))
         return;

      g_trade_active = false;
      g_entry_captured = false;
   }

   if(ordinal % P6_SIGNAL_MODULUS == 0 && ordinal + P6_EXIT_OFFSET < InpExpectedTickCount)
   {
      if(g_trade_active)
      {
         Fail("P6_MT5_PROBE_STATE_INVALID", "reference probe attempted to overlap logical trades");
         return;
      }
      const long signal_seq = g_trade_count;
      const string side = ((spread_scaled % 2) == 0 ? "LONG" : "SHORT");
      const string trade_id = TradeId(signal_seq);
      if(!EmitSignal(ordinal, timestamp_msc, signal_seq, side, trade_id, spread_scaled))
         return;

      g_trade_active = true;
      g_active_signal_seq = signal_seq;
      g_active_signal_ordinal = ordinal;
      g_active_entry_ordinal = ordinal + P6_ENTRY_OFFSET;
      g_active_exit_ordinal = ordinal + P6_EXIT_OFFSET;
      g_active_side = side;
      g_active_trade_id = trade_id;
      g_active_entry_price_scaled = 0;
      g_entry_captured = false;
      g_trade_count++;
   }

   g_last_time_msc = timestamp_msc;
   g_tick_count++;
}

bool WritePassReport()
{
   if(FileIsExist(g_report_name, FILE_COMMON))
   {
      Fail("P6_MT5_OUTPUT_EXISTS", "reference adapter refuses to overwrite existing report evidence");
      return false;
   }

   const int handle = FileOpen(g_report_name, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Fail("P6_MT5_REPORT_OPEN_FAILED", "cannot open FILE_COMMON report output");
      return false;
   }

   string report = "{";
   report += "\"adapter_version\":\"" + P6_MT5_ADAPTER_VERSION + "\",";
   report += "\"automatic_terminal_mutation\":false,";
   report += "\"canonical_logical_hash_root\":" + JStr(InpCanonicalLogicalHashRoot) + ",";
   report += "\"canonical_reorder\":false,";
   report += "\"canonical_symbol\":" + JStr(InpCanonicalSymbol) + ",";
   report += "\"dataset_id\":" + JStr(InpDatasetId) + ",";
   report += "\"environment_versions\":{";
   report += "\"program_version\":\"1.00\",";
   report += "\"terminal_build\":" + IntegerToString((long)TerminalInfoInteger(TERMINAL_BUILD));
   report += "},";
   report += "\"first_timestamp_msc\":" + JLong(g_first_time_msc) + ",";
   report += "\"input_mutation\":false,";
   report += "\"last_timestamp_msc\":" + JLong(g_last_time_msc) + ",";
   report += "\"logic_contract_sha256\":" + JStr(InpLogicContractSha256) + ",";
   report += "\"layer_counts\":{";
   report += "\"EXECUTION\":" + JLong(g_execution_seq) + ",";
   report += "\"INDICATOR_FEATURE\":" + JLong(g_feature_seq) + ",";
   report += "\"INPUT\":" + JLong(g_input_seq) + ",";
   report += "\"RESULT\":" + JLong(g_result_seq) + ",";
   report += "\"SIGNAL\":" + JLong(g_signal_seq_count);
   report += "},";
   report += "\"mt5_derivative_hash_root\":" + JStr(InpMt5DerivativeHashRoot) + ",";
   report += "\"mt5_symbol\":" + JStr(_Symbol) + ",";
   report += "\"parity_run_id\":" + JStr(InpParityRunId) + ",";
   report += "\"parquet_file_hash_root\":" + JStr(InpParquetFileHashRoot) + ",";
   report += "\"price_digits\":" + IntegerToString(InpPriceDigits) + ",";
   report += "\"price_scale\":" + JLong(InpPriceScale) + ",";
   report += "\"probe_id\":\"" + P6_PROBE_ID + "\",";
   report += "\"probe_version\":\"" + P6_PROBE_VERSION + "\",";
   report += "\"real_account_execution\":false,";
   report += "\"report_schema_version\":\"" + P6_MT5_REPORT_SCHEMA_VERSION + "\",";
   report += "\"source_hash_root\":" + JStr(InpSourceHashRoot) + ",";
   report += "\"source_reacquisition\":false,";
   report += "\"source_seq_bridge\":\"" + P6_SOURCE_SEQ_BRIDGE + "\",";
   report += "\"status\":\"PASS\",";
   report += "\"tick_count_total\":" + JLong(g_tick_count) + ",";
   report += "\"total_pnl_scaled\":" + JLong(g_total_pnl_scaled) + ",";
   report += "\"trace_event_count\":" + JLong(EventCountTotal()) + ",";
   report += "\"trace_file\":" + JStr(g_trace_name) + ",";
   report += "\"trace_format\":\"" + P6_TRACE_FORMAT + "\",";
   report += "\"trace_root_status\":\"COMPUTE_AFTER_INGEST\",";
   report += "\"trade_count\":" + JLong(g_trade_count);
   report += "}";

   const uint written = FileWriteString(handle, report);
   FileClose(handle);
   if(written == 0)
   {
      Fail("P6_MT5_REPORT_WRITE_FAILED", "FileWriteString did not write the report");
      return false;
   }
   return true;
}

double OnTester()
{
   if(g_trace_handle != INVALID_HANDLE)
   {
      FileFlush(g_trace_handle);
      FileClose(g_trace_handle);
      g_trace_handle = INVALID_HANDLE;
   }

   if(g_failed)
      return -1.0;
   if(g_tick_count != InpExpectedTickCount)
   {
      Fail("P6_MT5_TICK_COUNT_MISMATCH", "Strategy Tester tick count differs from bound run contract");
      return -1.0;
   }
   if(g_last_time_msc != InpExpectedLastTimeMsc)
   {
      Fail("P6_MT5_LAST_TIMESTAMP_MISMATCH", "last tester tick does not match bound last timestamp");
      return -1.0;
   }
   if(g_trade_active || g_entry_captured)
   {
      Fail("P6_MT5_EXECUTION_STATE_INVALID", "reference probe ended with an incomplete logical trade");
      return -1.0;
   }

   g_trace_handle = FileOpen(g_trace_name, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(g_trace_handle == INVALID_HANDLE)
   {
      Fail("P6_MT5_TRACE_REOPEN_FAILED", "cannot reopen local trace for aggregate result");
      return -1.0;
   }
   FileSeek(g_trace_handle, 0, SEEK_END);
   if(!EmitAggregateResult())
   {
      FileClose(g_trace_handle);
      g_trace_handle = INVALID_HANDLE;
      return -1.0;
   }
   FileFlush(g_trace_handle);
   FileClose(g_trace_handle);
   g_trace_handle = INVALID_HANDLE;

   if(!WritePassReport())
      return -1.0;

   PrintFormat(
      "HDH P6.4 PASS adapter=%s ticks=%I64d events=%I64d trades=%I64d pnl_scaled=%I64d trace=%s report=%s",
      P6_MT5_ADAPTER_VERSION,
      g_tick_count,
      EventCountTotal(),
      g_trade_count,
      g_total_pnl_scaled,
      g_trace_name,
      g_report_name
   );
   return 1.0;
}

void OnDeinit(const int reason)
{
   if(g_trace_handle != INVALID_HANDLE)
   {
      FileFlush(g_trace_handle);
      FileClose(g_trace_handle);
      g_trace_handle = INVALID_HANDLE;
   }
   if(g_failed)
      PrintFormat("HDH P6.4 STOP code=%s message=%s deinit_reason=%d", g_failure_code, g_failure_message, reason);
}
