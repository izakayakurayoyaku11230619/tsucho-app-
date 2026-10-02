//+------------------------------------------------------------------+
//|                                     EURUSD_ReEngineered_EA.mq4   |
//|                        Analysis-Driven Safe & Profit Optimization|
//+------------------------------------------------------------------+
#property copyright "Custom Engineering"
#property link      ""
#property version   "1.10"
#property strict

//--- 基本設定
input string   Trade_Settings        = "--- 基本設定 ---";
input int      MagicNumber           = 20261001;    // マジックナンバー
input double   FixedLotSize          = 0.02;        // 固定ロット（複利無効時）
input bool     UseCompoundLot        = true;        // 複利ロット運用の有効化
input double   BalancePer001Lot      = 1000.0;      // 0.01lotあたりの証拠金残高（$）
input int      Slippage              = 3;           // 許容スリッページ(pips)

//--- グリッド・ナンピン設定
input string   Grid_Settings         = "--- グリッド設定 ---";
input int      MaxPositions          = 2;           // 最大ポジション数（ナンピン上限） ※実績分析で2段目以降の損失が大きかったため3→2に縮小
input double   LotMultiplier         = 1.4;         // ロット増加倍率
input int      ATR_Period            = 14;          // ATR計算期間
input double   ATR_Grid_Multiplier   = 1.5;         // ATRステップ倍率
input int      MinStepPips           = 25;          // 最小ナンピン間隔(pips)

//--- 利確・損切り設定
input string   Exit_Settings         = "--- 決済・安全対策 ---";
input double   SingleTradeTP_Pips    = 15.0;        // 単発時利確幅(pips)
input double   TrailingStart_Pips    = 12.0;        // トレーリング開始(pips)
input double   TrailingStep_Pips     = 5.0;         // トレーリング幅(pips)
input double   BasketProfitTargetUSD = 15.0;        // バスケット目標利益額($)
input int      MaxHoldHours          = 48;          // タイムストップ（含み損なしでの最終決済・時間単位）
input int      ForceCutHours         = 24;          // 含み損のまま経過したら強制損切り（実績で24h超保有が主な損失源だったため）
input double   BasketMaxLossUSD      = 50.0;        // バスケット単位の絶対損切りライン($)
input double   MaxDrawdownPercent    = 5.0;         // このシンボルの含み損に対する最大許容ドローダウン（口座残高の%）
input double   HardStopLossPips      = 150.0;       // 発注時に同時設定する緊急ストップ(pips)。0で無効

//--- タイムフィルター（取引除外時間：サーバー時間、実績分析により通貨ペア別に分離）
input string   Time_Settings         = "--- タイムフィルター ---";
input bool     UseTimeFilter         = true;
input string   BlockedHours_EURUSD   = "9,20,23";       // EURUSDの赤字時間帯
input string   BlockedHours_GBPUSD   = "0,1,2,5,8,19";  // GBPUSDの赤字時間帯（20時はGBPUSDでは好成績のため除外）
input string   BlockedHours_Default  = "5,8,19,20,23";  // それ以外の通貨ペア用のフォールバック

//+------------------------------------------------------------------+
//| 内部グローバル変数                                               |
//+------------------------------------------------------------------+
double g_pipPoint;

//+------------------------------------------------------------------+
//| 初期化関数                                                       |
//+------------------------------------------------------------------+
int OnInit()
{
   if(Digits == 3 || Digits == 5) g_pipPoint = Point * 10;
   else g_pipPoint = Point;

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| 終了処理関数                                                     |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
}

//+------------------------------------------------------------------+
//| メインティック処理                                               |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. このシンボルの最大許容損失（緊急安全停止）の確認
   CheckMaxDrawdownProtection();

   // 2. 既存ポジションの決済チェック（バスケットTP・タイムストップ・強制損切り・トレーリング）
   ManageOpenPositions();

   // 3. タイムフィルター判定
   if(UseTimeFilter && IsHourBlocked(Hour())) return;

   // 4. 新規・ナンピンエントリーチェック
   CheckEntrySignals();
}

//+------------------------------------------------------------------+
//| ロット正規化（最小/最大/刻み幅に丸める）                         |
//+------------------------------------------------------------------+
double NormalizeLot(double lot)
{
   double minLot = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot = MarketInfo(Symbol(), MODE_MAXLOT);
   double lotStep = MarketInfo(Symbol(), MODE_LOTSTEP);

   lot = MathFloor(lot / lotStep) * lotStep;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;

   return lot;
}

//+------------------------------------------------------------------+
//| ロット計算（複利 or 固定）                                       |
//+------------------------------------------------------------------+
double CalculateBaseLot()
{
   if(!UseCompoundLot) return FixedLotSize;

   double calculated = (AccountBalance() / BalancePer001Lot) * 0.01;
   return NormalizeLot(calculated);
}

//+------------------------------------------------------------------+
//| 通貨ペアに応じた赤字時間帯リストの取得                           |
//+------------------------------------------------------------------+
string GetBlockedHoursForSymbol()
{
   string sym = Symbol();
   if(StringFind(sym, "EURUSD") >= 0) return BlockedHours_EURUSD;
   if(StringFind(sym, "GBPUSD") >= 0) return BlockedHours_GBPUSD;
   return BlockedHours_Default;
}

//+------------------------------------------------------------------+
//| 時間フィルター判定                                               |
//+------------------------------------------------------------------+
bool IsHourBlocked(int currentHour)
{
   string hours[];
   int count = StringSplit(GetBlockedHoursForSymbol(), ',', hours);
   for(int i = 0; i < count; i++)
   {
      if(StrToInteger(hours[i]) == currentHour) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| エントリー判断                                                   |
//+------------------------------------------------------------------+
void CheckEntrySignals()
{
   int buyCount = 0, sellCount = 0;
   double lastBuyPrice = 0, lastSellPrice = 0;
   datetime oldestTime = 0;

   CountOrders(buyCount, sellCount, lastBuyPrice, lastSellPrice, oldestTime);

   // ナンピン間隔の計算 (ATR連動)
   double atr = iATR(Symbol(), PERIOD_H1, ATR_Period, 0);
   double stepPips = MathMax(MinStepPips, (atr / g_pipPoint) * ATR_Grid_Multiplier);

   // --- 1. 初回エントリー（ノーポジション時） ---
   if(buyCount == 0 && sellCount == 0)
   {
      // 欧州市場向けトレンド判定（200EMA）＆ オシレーター（RSI）
      double ema200 = iMA(Symbol(), PERIOD_M15, 200, 0, MODE_EMA, PRICE_CLOSE, 0);
      double rsi = iRSI(Symbol(), PERIOD_M15, 14, PRICE_CLOSE, 0);

      // 上位足下降トレンド ＋ 一時的買われすぎでSell先行（取引傾向の再現）
      if(Bid < ema200 && rsi > 65)
      {
         OpenOrder(OP_SELL, CalculateBaseLot());
      }
      // 上位足上昇トレンド ＋ 一時的売られすぎでBuy
      else if(Ask > ema200 && rsi < 35)
      {
         OpenOrder(OP_BUY, CalculateBaseLot());
      }
   }
   // --- 2. 追撃ナンピンエントリー ---
   else
   {
      // 買いポジションのナンピン
      if(buyCount > 0 && buyCount < MaxPositions)
      {
         if((lastBuyPrice - Ask) >= stepPips * g_pipPoint)
         {
            double nextLot = NormalizeLot(CalculateBaseLot() * MathPow(LotMultiplier, buyCount));
            OpenOrder(OP_BUY, nextLot);
         }
      }
      // 売りポジションのナンピン
      else if(sellCount > 0 && sellCount < MaxPositions)
      {
         if((Bid - lastSellPrice) >= stepPips * g_pipPoint)
         {
            double nextLot = NormalizeLot(CalculateBaseLot() * MathPow(LotMultiplier, sellCount));
            OpenOrder(OP_SELL, nextLot);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 注文発注処理                                                     |
//+------------------------------------------------------------------+
void OpenOrder(int cmd, double lot)
{
   double price = (cmd == OP_BUY) ? Ask : Bid;

   // 端末切断や週末ギャップ等に備えたサーバー側の緊急ストップ（通常のグリッド運用には影響しない広めの値）
   double sl = 0;
   if(HardStopLossPips > 0)
   {
      sl = (cmd == OP_BUY) ? price - HardStopLossPips * g_pipPoint
                           : price + HardStopLossPips * g_pipPoint;
   }

   int ticket = OrderSend(Symbol(), cmd, lot, price, Slippage, sl, 0, "ReEngineered_EA", MagicNumber, 0, (cmd == OP_BUY) ? clrBlue : clrRed);
   if(ticket < 0)
   {
      Print("OrderSend Failed. Error: ", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| このシンボル/マジックナンバーの合計含み損益                     |
//+------------------------------------------------------------------+
double GetSymbolFloatingPL()
{
   double total = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == Symbol() && OrderMagicNumber() == MagicNumber)
         {
            total += (OrderProfit() + OrderCommission() + OrderSwap());
         }
      }
   }
   return total;
}

//+------------------------------------------------------------------+
//| 既存ポジションの決済管理                                         |
//+------------------------------------------------------------------+
void ManageOpenPositions()
{
   int buyCount = 0, sellCount = 0;
   double lastBuyPrice = 0, lastSellPrice = 0;
   datetime oldestTime = 0;
   CountOrders(buyCount, sellCount, lastBuyPrice, lastSellPrice, oldestTime);

   int totalPos = buyCount + sellCount;
   if(totalPos == 0) return;

   // 保有時間の確認（タイムストップ・強制損切り判定）
   double holdHours = (oldestTime > 0) ? (TimeCurrent() - oldestTime) / 3600.0 : 0;
   bool isTimeout = (holdHours >= MaxHoldHours);
   bool isForceCut = (holdHours >= ForceCutHours);

   double totalBasketProfit = GetSymbolFloatingPL();

   // 複数ポジション時のバスケット利確、またはタイムストップ（微損・微益で即脱出）
   if(totalPos > 1)
   {
      if(totalBasketProfit >= BasketProfitTargetUSD || (isTimeout && totalBasketProfit >= 0))
      {
         CloseAllPositions();
         return;
      }
      // 含み損のまま長時間放置しない（実績データで24h超保有が主な損失源だったための強制損切り）
      if(isForceCut && totalBasketProfit < 0)
      {
         Print("Force-cut (basket): ", Symbol(), " held ", holdHours, "h while ", totalBasketProfit);
         CloseAllPositions();
         return;
      }
   }
   // 単一ポジション時のトレーリングストップ / TP処理
   else if(totalPos == 1)
   {
      // 単発ポジションも同様に、含み損のまま長時間放置しない
      if(isForceCut && totalBasketProfit < 0)
      {
         Print("Force-cut (single): ", Symbol(), " held ", holdHours, "h while ", totalBasketProfit);
         CloseAllPositions();
         return;
      }

      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         {
            if(OrderSymbol() == Symbol() && OrderMagicNumber() == MagicNumber)
            {
               double openPrice = OrderOpenPrice();

               // Buyトレーリング
               if(OrderType() == OP_BUY)
               {
                  double pipsGain = (Bid - openPrice) / g_pipPoint;
                  if(pipsGain >= SingleTradeTP_Pips)
                  {
                     OrderClose(OrderTicket(), OrderLots(), Bid, Slippage, clrGreen);
                  }
                  else if(pipsGain >= TrailingStart_Pips)
                  {
                     double newSL = Bid - (TrailingStep_Pips * g_pipPoint);
                     if(OrderStopLoss() < newSL)
                     {
                        OrderModify(OrderTicket(), openPrice, newSL, 0, 0, clrGreen);
                     }
                  }
               }
               // Sellトレーリング
               else if(OrderType() == OP_SELL)
               {
                  double pipsGain = (openPrice - Ask) / g_pipPoint;
                  if(pipsGain >= SingleTradeTP_Pips)
                  {
                     OrderClose(OrderTicket(), OrderLots(), Ask, Slippage, clrGreen);
                  }
                  else if(pipsGain >= TrailingStart_Pips)
                  {
                     double newSL = Ask + (TrailingStep_Pips * g_pipPoint);
                     if(OrderStopLoss() == 0 || OrderStopLoss() > newSL)
                     {
                        OrderModify(OrderTicket(), openPrice, newSL, 0, 0, clrGreen);
                     }
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| ドローダウン保護機能（シンボル単位の口座保護）                   |
//+------------------------------------------------------------------+
void CheckMaxDrawdownProtection()
{
   double balance = AccountBalance();
   if(balance <= 0) return;

   // 口座全体のエクイティではなく、このシンボルの含み損益のみで判定する。
   // （同一口座で他通貨ペアも運用している場合、他ペアの含み損に巻き込まれて
   //   健全なポジションまで閉じてしまうのを防ぐため）
   double symbolFloatingPL = GetSymbolFloatingPL();
   if(symbolFloatingPL >= 0) return;

   double drawdownPercent = (-symbolFloatingPL) / balance * 100.0;
   if(drawdownPercent >= MaxDrawdownPercent || (-symbolFloatingPL) >= BasketMaxLossUSD)
   {
      Print("Max Drawdown Breached (", Symbol(), "): floatingPL=", symbolFloatingPL, " Forcing Close All.");
      CloseAllPositions();
   }
}

//+------------------------------------------------------------------+
//| 全ポジション決済ヘルパー                                         |
//+------------------------------------------------------------------+
void CloseAllPositions()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == Symbol() && OrderMagicNumber() == MagicNumber)
         {
            if(OrderType() == OP_BUY)
               OrderClose(OrderTicket(), OrderLots(), Bid, Slippage, clrYellow);
            else if(OrderType() == OP_SELL)
               OrderClose(OrderTicket(), OrderLots(), Ask, Slippage, clrYellow);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| ポジション情報集計ヘルパー                                       |
//+------------------------------------------------------------------+
void CountOrders(int &buyCount, int &sellCount, double &lastBuyPrice, double &lastSellPrice, datetime &oldestTime)
{
   buyCount = 0;
   sellCount = 0;
   lastBuyPrice = 0;
   lastSellPrice = 0;
   oldestTime = 0;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == Symbol() && OrderMagicNumber() == MagicNumber)
         {
            if(oldestTime == 0 || OrderOpenTime() < oldestTime)
               oldestTime = OrderOpenTime();

            if(OrderType() == OP_BUY)
            {
               buyCount++;
               if(lastBuyPrice == 0 || OrderOpenPrice() < lastBuyPrice)
                  lastBuyPrice = OrderOpenPrice();
            }
            else if(OrderType() == OP_SELL)
            {
               sellCount++;
               if(lastSellPrice == 0 || OrderOpenPrice() > lastSellPrice)
                  lastSellPrice = OrderOpenPrice();
            }
         }
      }
   }
}
