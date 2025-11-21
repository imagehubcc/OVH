export interface DatacenterInfo {
  code: string;
  name: string;
  region: string;
  flag: string;
  countryCode: string;
}

export const OVH_DATACENTERS: DatacenterInfo[] = [
  { code: "gra", name: "格拉夫尼茨", region: "法国", flag: "🇫🇷", countryCode: "fr" },
  { code: "sbg", name: "斯特拉斯堡", region: "法国", flag: "🇫🇷", countryCode: "fr" },
  { code: "rbx", name: "鲁贝", region: "法国", flag: "🇫🇷", countryCode: "fr" },
  { code: "bhs", name: "博阿尔诺", region: "加拿大", flag: "🇨🇦", countryCode: "ca" },
  { code: "mum", name: "孟买", region: "印度", flag: "🇮🇳", countryCode: "in" },
  { code: "waw", name: "华沙", region: "波兰", flag: "🇵🇱", countryCode: "pl" },
  { code: "fra", name: "林堡", region: "德国", flag: "🇩🇪", countryCode: "de" },
  { code: "lon", name: "伦敦", region: "英国", flag: "🇬🇧", countryCode: "gb" },
  { code: "hil", name: "俄勒冈", region: "美国西部", flag: "🇺🇸", countryCode: "us" },
  { code: "vin", name: "弗吉尼亚", region: "美国东部", flag: "🇺🇸", countryCode: "us" },
  { code: "sgp", name: "新加坡", region: "新加坡", flag: "🇸🇬", countryCode: "sg" },
  { code: "syd", name: "悉尼", region: "澳大利亚", flag: "🇦🇺", countryCode: "au" }
]; 