export class ApiConstants {
  public readonly additional: boolean = true;
  public readonly limit: number = 20;
  public readonly offset: number = 20;
  public readonly order: 'acs' | 'desc' = 'desc';
  public readonly sort:
    'time_created' | 'time_left' | 'current_price' | 'buyout_price' =
    'time_created';
}

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
  levelPoint: number;
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
