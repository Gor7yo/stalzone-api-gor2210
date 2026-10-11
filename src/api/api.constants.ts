// Типы ответов STALCRAFT API

export interface AuctionItemLotsResponse {
  total: number;
  lots: {
    itemId: string;
    amount: number;
    startPrice: number;
    buyoutPrice: number;
    startTime: number;
    endTime: string;
    additional?: { [key: string]: any };
  }[];
}
export interface AuctionItemHistoryResponse {
  total: number;
  prices: {
    amount: string;
    price: number;
    time: number;
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
