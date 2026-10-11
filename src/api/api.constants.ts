// Типы ответов STALCRAFT API

export interface AuctionItemLotsResponse {
  total: number;
  lots: {
    itemId: string;
    amount: number;
    startPrice: number;
    /** Текущая ставка (нет, если ставок не было) */
    currentPrice?: number;
    buyoutPrice: number;
    /** ISO-время, «2026-10-11T17:24:37Z» */
    startTime: string;
    endTime: string;
    additional?: { [key: string]: any };
  }[];
}
export interface AuctionItemHistoryResponse {
  total: number;
  prices: {
    amount: number;
    price: number;
    /** ISO-время */
    time: string;
    additional?: { [key: string]: any };
  }[];
}

export interface IClanInfo {
  id: string;
  name: string;
  tag: string;
  level: number;
  levelPoints: number;
  registrationTime: Date;
  alliance?: string;
  description: string;
  leader: string;
  memberCount: number;
  region?: string;
}

export interface IClansList {
  totalClans: number;
  data: IClanInfo[];
}

export interface IRegionData {
  [region: string]: IClansList;
}
