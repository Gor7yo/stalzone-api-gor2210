export class ApiConstants {
  public readonly additional: boolean = true;
  public readonly limit: number = 20;
  public readonly offset: number = 20;
  public readonly order: 'acs' | 'desc' = 'desc';
  public readonly sort:
    'time_created' | 'time_left' | 'current_price' | 'buyout_price' =
    'time_created';
}
