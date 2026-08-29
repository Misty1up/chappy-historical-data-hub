#property script_show_inputs
#property strict

input string InpCustomSymbol = "HDH_EURUSD";
input string InpCsvFile = "2026-01-05.ticks.csv";
input int InpExpectedDigits = 5;
input long InpExpectedRows = 0;

bool ReadAndValidateHeader(const int handle)
{
   const string expected[6] = {"time_msc", "bid", "ask", "bid_scaled", "ask_scaled", "source_seq"};
   for(int i = 0; i < 6; i++)
   {
      string actual = FileReadString(handle);
      if(actual != expected[i])
      {
         PrintFormat("Header mismatch at column %d: expected=%s actual=%s", i, expected[i], actual);
         return false;
      }
   }
   return true;
}

void OnStart()
{
   ResetLastError();
   long actual_digits = 0;
   if(!SymbolInfoInteger(InpCustomSymbol, SYMBOL_DIGITS, actual_digits))
   {
      PrintFormat("SymbolInfoInteger failed for %s error=%d. Create/configure the custom symbol before import.", InpCustomSymbol, GetLastError());
      return;
   }
   if(actual_digits != InpExpectedDigits)
   {
      PrintFormat("Digits mismatch for %s: expected=%d actual=%d", InpCustomSymbol, InpExpectedDigits, actual_digits);
      return;
   }

   const int handle = FileOpen(InpCsvFile, FILE_READ | FILE_CSV | FILE_ANSI | FILE_SHARE_READ, ',');
   if(handle == INVALID_HANDLE)
   {
      PrintFormat("FileOpen failed: %s error=%d", InpCsvFile, GetLastError());
      return;
   }

   if(!ReadAndValidateHeader(handle))
   {
      FileClose(handle);
      return;
   }

   MqlTick ticks[];
   long previous_time_msc = -1;
   long expected_source_seq = 0;

   while(!FileIsEnding(handle))
   {
      string time_text = FileReadString(handle);
      if(time_text == "" && FileIsEnding(handle))
         break;
      string bid_text = FileReadString(handle);
      string ask_text = FileReadString(handle);
      string bid_scaled_text = FileReadString(handle);
      string ask_scaled_text = FileReadString(handle);
      string source_seq_text = FileReadString(handle);

      const long time_msc = StringToInteger(time_text);
      const double bid = StringToDouble(bid_text);
      const double ask = StringToDouble(ask_text);
      const long source_seq = StringToInteger(source_seq_text);

      if(source_seq != expected_source_seq)
      {
         PrintFormat("source_seq discontinuity: expected=%I64d actual=%I64d", expected_source_seq, source_seq);
         FileClose(handle);
         return;
      }
      if(previous_time_msc >= 0 && time_msc < previous_time_msc)
      {
         PrintFormat("time_msc decreased at source_seq=%I64d; sorting is forbidden", source_seq);
         FileClose(handle);
         return;
      }
      if(!(bid > 0.0) || !(ask > 0.0) || bid > ask)
      {
         PrintFormat("Invalid Bid/Ask at source_seq=%I64d bid=%s ask=%s", source_seq, bid_text, ask_text);
         FileClose(handle);
         return;
      }

      const int next_size = ArraySize(ticks) + 1;
      if(ArrayResize(ticks, next_size, 100000) != next_size)
      {
         Print("ArrayResize failed");
         FileClose(handle);
         return;
      }

      MqlTick tick;
      ZeroMemory(tick);
      tick.time_msc = time_msc;
      tick.time = (datetime)(time_msc / 1000);
      tick.bid = bid;
      tick.ask = ask;
      tick.last = 0.0;
      tick.volume = 0;
      tick.volume_real = 0.0;
      tick.flags = TICK_FLAG_BID | TICK_FLAG_ASK;
      ticks[next_size - 1] = tick;

      // bid_scaled/ask_scaled stay in the CSV as an audit bridge to Canonical.
      // They are intentionally not recomputed with floating-point rounding in MQL5.
      if(bid_scaled_text == "" || ask_scaled_text == "")
      {
         PrintFormat("Missing scaled audit field at source_seq=%I64d", source_seq);
         FileClose(handle);
         return;
      }

      previous_time_msc = time_msc;
      expected_source_seq++;
   }
   FileClose(handle);

   const int count = ArraySize(ticks);
   if(count <= 0)
   {
      Print("No derivative ticks were read");
      return;
   }
   if(InpExpectedRows > 0 && count != InpExpectedRows)
   {
      PrintFormat("Row count mismatch: expected=%I64d actual=%d", InpExpectedRows, count);
      return;
   }

   const long from_msc = ticks[0].time_msc;
   const long to_msc = ticks[count - 1].time_msc;
   ResetLastError();
   const int replaced = CustomTicksReplace(InpCustomSymbol, from_msc, to_msc, ticks);
   if(replaced != count)
   {
      PrintFormat("CustomTicksReplace mismatch: requested=%d replaced=%d error=%d", count, replaced, GetLastError());
      return;
   }

   PrintFormat("HDH import PASS symbol=%s rows=%d from_msc=%I64d to_msc=%I64d", InpCustomSymbol, count, from_msc, to_msc);
}
