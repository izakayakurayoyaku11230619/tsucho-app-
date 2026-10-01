//+------------------------------------------------------------------+
//|                                     EURUSD_ReEngineered_EA.mq4   |
//|                        Analysis-Driven Safe & Profit Optimization|
//+------------------------------------------------------------------+
#property copyright "Custom Engineering"
#property link      ""
#property version   "1.00"
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
input int      MaxPositions          = 3;           // 最大ポジション数（ナンピン上限）
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
input int      MaxHoldHours          = 48;          // タイムストップ（最大保有時間・時間単位）
input double   MaxDrawdownPercent    = 5.0;         // 最大許容ドローダウン（口座残高の%）

//--- タイムフィルター（取引除外時間：サーバー時間）
input string   Time_Settings         = "--- タイムフィルター ---";
input bool     UseTimeFilter         = true;
input string   BlockedHours          = "5,8,19,20,23"; // 赤字時間帯（カンマ区切り）

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
   // 1. 口座全体の最大許容損失（緊急安全停止）の確認
   CheckMaxDrawdownProtection();

   // 2. 既存ポジションの決済チェック（バスケットTP・タイムストップ・トレーリング）
   ManageOpenPositions();

   // 3. タイムフィルター判定
   if(UseTimeFilter && IsHourBlocked(Hour())) return;

   // 4. 新規・ナンピンエントリーチェック
   CheckEntrySignals();
}

//+------------------------------------------------------------------+
//| ロット計算（複利 or 固定）                                       |
//+------------------------------------------------------------------+
double CalculateBaseLot()
{
   if(!UseCompoundLot) return FixedLotSize;

   double calculated = (AccountBalance() / BalancePer001Lot) * 0.01;
   double minLot = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot = MarketInfo(Symbol(), MODE_MAXLOT);
   double lotStep = MarketInfo(Symbol(), MODE_LOTSTEP);

   calculated = MathFloor(calculated / lotStep) * lotStep;
   if(calculated < minLot) calculated = minLot;
   if(calculated > maxLot) calculated = maxLot;

   return calculated;
}

//+------------------------------------------------------------------+
//| 時間フィルター判定                                               |
//+------------------------------------------------------------------+
bool IsHourBlocked(int currentHour)
{
   string hours[];
   int count = StringSplit(BlockedHours, ',', hours);
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
            double nextLot = NormalizeDouble(CalculateBaseLot() * MathPow(LotMultiplier, buyCount), 2);
            OpenOrder(OP_BUY, nextLot);
         }
      }
      // 売りポジションのナンピン
      else if(sellCount > 0 && sellCount < MaxPositions)
      {
         if((Bid - lastSellPrice) >= stepPips * g_pipPoint)
         {
            double nextLot = NormalizeDouble(CalculateBaseLot() * MathPow(LotMultiplier, sellCount), 2);
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
   int ticket = OrderSend(Symbol(), cmd, lot, price, Slippage, 0, 0, "ReEngineered_EA", MagicNumber, 0, (cmd == OP_BUY) ? clrBlue : clrRed);
   if(ticket < 0)
   {
      Print("OrderSend Failed. Error: ", GetLastError());
   }
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

   // 保有時間の確認（タイムストップ判定）
   bool isTimeout = false;
   if(oldestTime > 0 && (TimeCurrent() - oldestTime) >= (MaxHoldHours * 3600))
   {
      isTimeout = true;
   }

   // 合計含み損益の算出
   double totalBasketProfit = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == Symbol() && OrderMagicNumber() == MagicNumber)
         {
            totalBasketProfit += (OrderProfit() + OrderCommission() + OrderSwap());
         }
      }
   }

   // 複数ポジション時のバスケット利確、またはタイムストップ（微損・微益で即脱出）
   if(totalPos > 1)
   {
      if(totalBasketProfit >= BasketProfitTargetUSD || (isTimeout && totalBasketProfit >= 0))
      {
         CloseAllPositions();
         return;
      }
   }
   // 単一ポジション時のトレーリングストップ / TP処理
   else if(totalPos == 1)
   {
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
//| ドローダウン保護機能（口座保護）                                 |
//+------------------------------------------------------------------+
void CheckMaxDrawdownProtection()
{
   double balance = AccountBalance();
   double equity = AccountEquity();
   if(balance <= 0) return;

   double drawdown = (balance - equity) / balance * 100.0;
   if(drawdown >= MaxDrawdownPercent)
   {
      Print("Max Drawdown Breached! Forcing Close All.");
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
