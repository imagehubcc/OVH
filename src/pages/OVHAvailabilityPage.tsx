import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { RefreshCw, Search, Database, Filter, Download, TrendingUp, ChevronLeft, ChevronRight } from 'lucide-react';
import axios from 'axios';
import apiClient from '@/utils/apiClient';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * OVH 数据中心可用性查询页面
 * 直接调用 OVH 公开 API（无需认证）
 * 根据后端配置的 endpoint 自动选择对应的区域 API：
 * - EU: https://eu.api.ovh.com/v1/dedicated/server/datacenter/availabilities
 * - US: https://api.us.ovhcloud.com/v1/dedicated/server/datacenter/availabilities
 * - CA: https://ca.api.ovh.com/v1/dedicated/server/datacenter/availabilities
 */

interface DatacenterInfo {
  datacenter: string;
  availability: string;
}

interface AvailabilityItem {
  fqn: string;
  memory: string;
  planCode: string;
  server: string;
  storage: string;
  systemStorage?: string;
  datacenters: DatacenterInfo[];
}

const OVHAvailabilityPage = () => {
  const isMobile = useIsMobile();
  const [availabilities, setAvailabilities] = useState<AvailabilityItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(true); // 配置加载状态
  const [endpoint, setEndpoint] = useState<string>('');
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  
  // 搜索和过滤
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterDatacenter, setFilterDatacenter] = useState('all');
  const [filterAvailability, setFilterAvailability] = useState('all');
  const [filterMemory, setFilterMemory] = useState('all');
  
  // 排序
  const [sortBy, setSortBy] = useState<'planCode' | 'memory' | 'availability'>('planCode');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // 分页
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = isMobile ? 20 : 50;
  
  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1); // 搜索时重置页码
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);
  
  // 过滤条件改变时重置页码
  useEffect(() => {
    setCurrentPage(1);
  }, [filterDatacenter, filterAvailability, filterMemory, sortBy, sortOrder]);

  // 根据 endpoint 获取对应的 API 基础地址
  const getApiBaseUrl = (endpoint: string): string => {
    switch (endpoint) {
      case 'ovh-us':
        return 'https://api.us.ovhcloud.com';
      case 'ovh-ca':
        return 'https://ca.api.ovh.com';
      case 'ovh-eu':
      default:
        return 'https://eu.api.ovh.com';
    }
  };

  // 获取所有可用性数据
  const fetchAvailabilities = useCallback(async () => {
    if (!apiBaseUrl) return;
    
    setIsLoading(true);
    try {
      const apiUrl = `${apiBaseUrl}/v1/dedicated/server/datacenter/availabilities`;
      toast.info('正在从 OVH 公开 API 获取数据...', { duration: 2000 });
      
      console.log(`正在从 ${apiUrl} 获取数据...`);
      
      // 直接调用 OVH 公开 API（无需认证）
      const response = await axios.get(apiUrl, {
        timeout: 30000
      });
      
      console.log('OVH API 返回数据:', response.data);
      setAvailabilities(response.data);
      toast.success(`成功获取 ${response.data.length} 条可用性记录`);
    } catch (error: any) {
      console.error('获取 OVH 数据失败:', error);
      
      let errorMessage = '获取数据失败';
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        errorMessage = '请求超时，请重试';
      } else if (error.message) {
        errorMessage = `获取数据失败: ${error.message}`;
      }
      
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  // 获取 endpoint 配置
  const fetchEndpointConfig = useCallback(async () => {
    setIsConfigLoading(true);
    try {
      const response = await apiClient.get('/endpoint-config');
      const configEndpoint = response.data.endpoint || 'ovh-eu';
      setEndpoint(configEndpoint);
      const baseUrl = getApiBaseUrl(configEndpoint);
      setApiBaseUrl(baseUrl);
      console.log(`✅ 使用 OVH API: ${configEndpoint} - ${baseUrl}`);
    } catch (error) {
      console.error('获取 endpoint 配置失败，使用默认值 ovh-eu:', error);
      setEndpoint('ovh-eu');
      setApiBaseUrl('https://eu.api.ovh.com');
      toast.error('获取区域配置失败，使用默认欧洲区域');
    } finally {
      setIsConfigLoading(false);
    }
  }, []);

  // 初始加载：先获取 endpoint 配置，再获取数据
  useEffect(() => {
    fetchEndpointConfig();
  }, [fetchEndpointConfig]);

  // 当 apiBaseUrl 改变时，获取数据
  useEffect(() => {
    if (apiBaseUrl) {
      fetchAvailabilities();
    }
  }, [apiBaseUrl, fetchAvailabilities]);

  // 使用useMemo优化过滤和排序
  const filteredData = useMemo(() => {
    let filtered = [...availabilities];
    
    // 搜索过滤（使用防抖后的搜索词）
    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase();
      filtered = filtered.filter(item =>
        item.planCode.toLowerCase().includes(term) ||
        item.server.toLowerCase().includes(term) ||
        item.fqn.toLowerCase().includes(term) ||
        item.memory.toLowerCase().includes(term) ||
        item.storage.toLowerCase().includes(term)
      );
    }
    
    // 数据中心过滤
    if (filterDatacenter !== 'all') {
      filtered = filtered.filter(item =>
        item.datacenters.some(dc => dc.datacenter.toLowerCase() === filterDatacenter.toLowerCase())
      );
    }
    
    // 可用性状态过滤
    if (filterAvailability !== 'all') {
      filtered = filtered.filter(item => {
        if (filterAvailability === 'available') {
          return item.datacenters.some(dc => 
            dc.availability !== 'unavailable' && dc.availability !== 'unknown'
          );
        } else if (filterAvailability === 'unavailable') {
          return item.datacenters.every(dc => 
            dc.availability === 'unavailable' || dc.availability === 'unknown'
          );
        } else if (filterAvailability === '1h') {
          return item.datacenters.some(dc => 
            dc.availability === '1H-low' || dc.availability === '1H-high'
          );
        }
        return true;
      });
    }
    
    // 内存过滤
    if (filterMemory !== 'all') {
      filtered = filtered.filter(item => {
        const memMatch = item.memory.match(/(\d+)g/i);
        if (memMatch) {
          const memSize = parseInt(memMatch[1]);
          switch (filterMemory) {
            case '<=128': return memSize <= 128;
            case '256': return memSize >= 128 && memSize <= 256;
            case '512': return memSize >= 256 && memSize <= 512;
            case '>=1024': return memSize >= 1024;
            default: return true;
          }
        }
        return true;
      });
    }
    
    // 排序
    filtered.sort((a, b) => {
      let compareValue = 0;
      
      switch (sortBy) {
        case 'planCode':
          compareValue = a.planCode.localeCompare(b.planCode);
          break;
        case 'memory':
          const aMemMatch = a.memory.match(/(\d+)g/i);
          const bMemMatch = b.memory.match(/(\d+)g/i);
          const aMem = aMemMatch ? parseInt(aMemMatch[1]) : 0;
          const bMem = bMemMatch ? parseInt(bMemMatch[1]) : 0;
          compareValue = aMem - bMem;
          break;
        case 'availability':
          const aAvail = a.datacenters.filter(dc => 
            dc.availability !== 'unavailable' && dc.availability !== 'unknown'
          ).length;
          const bAvail = b.datacenters.filter(dc => 
            dc.availability !== 'unavailable' && dc.availability !== 'unknown'
          ).length;
          compareValue = aAvail - bAvail;
          break;
      }
      
      return sortOrder === 'asc' ? compareValue : -compareValue;
    });
    
    return filtered;
  }, [availabilities, debouncedSearch, filterDatacenter, filterAvailability, filterMemory, sortBy, sortOrder]);
  
  // 分页数据
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filteredData.slice(startIndex, endIndex);
  }, [filteredData, currentPage, itemsPerPage]);
  
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);

  // 导出数据为 JSON
  const exportData = () => {
    const dataStr = JSON.stringify(filteredData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ovh-availability-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('数据已导出');
  };

  // 统计信息
  const stats = {
    total: filteredData.length,
    available: filteredData.filter(item => 
      item.datacenters.some(dc => 
        dc.availability !== 'unavailable' && dc.availability !== 'unknown'
      )
    ).length,
    oneHour: filteredData.filter(item => 
      item.datacenters.some(dc => 
        dc.availability === '1H-low' || dc.availability === '1H-high'
      )
    ).length,
  };

  // 获取可用性状态的显示信息
  const getAvailabilityInfo = (availability: string) => {
    switch (availability) {
      case '1H-low':
        return { text: '1小时-低库存', color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30' };
      case '1H-high':
        return { text: '1小时-高库存', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30' };
      case '72H':
        return { text: '72小时', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' };
      case '480H':
        return { text: '480小时', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' };
      case 'unavailable':
        return { text: '不可用', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' };
      case 'unknown':
        return { text: '未知', color: 'text-gray-400', bg: 'bg-gray-500/10', border: 'border-gray-500/30' };
      default:
        return { text: availability, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30' };
    }
  };

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className={`${isMobile ? 'text-2xl' : 'text-3xl'} font-bold mb-1 cyber-glow-text`}>OVH 实时可用性</h1>
            <p className="text-cyber-muted text-sm">直接查询 OVH 公开 API（无需认证）</p>
          </div>
          
          <div className="flex gap-2">
            <Button
              onClick={exportData}
              disabled={filteredData.length === 0}
              variant="cyber"
              size="sm"
              className="flex items-center gap-2 text-xs sm:text-sm"
            >
              <Download className="w-3 h-3 sm:w-4 sm:h-4" />
              {!isMobile && '导出JSON'}
            </Button>
            <Button
              onClick={fetchAvailabilities}
              disabled={isLoading}
              variant="cyber"
              size="sm"
              className="flex items-center gap-2 text-xs sm:text-sm"
            >
              <RefreshCw className={`w-3 h-3 sm:w-4 sm:h-4 ${isLoading ? 'animate-spin' : ''}`} />
              {isLoading ? '加载中' : '刷新'}
            </Button>
          </div>
        </div>
      </motion.div>

      {/* API 信息 */}
      <div className="cyber-panel p-4 border-cyan-500/50">
        <div className="flex items-start gap-3">
          <Database className="w-5 h-5 text-cyan-400 mt-0.5" />
          <div className="flex-1">
            {isConfigLoading && !endpoint ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full"></div>
                <span className="text-cyber-muted text-sm">正在加载区域配置...</span>
              </div>
            ) : endpoint ? (
              <>
                <h3 className="font-semibold text-cyan-400 mb-2 flex items-center gap-2">
                  OVH 公开 API
                  <span className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
                    {endpoint === 'ovh-us' ? '🇺🇸 美国' : endpoint === 'ovh-ca' ? '🇨🇦 加拿大' : '🇪🇺 欧洲'}
                  </span>
                </h3>
                <div className="space-y-1 text-sm">
                  <div className="flex items-start gap-2">
                    <span className="text-cyber-muted min-w-[60px]">端点：</span>
                    <code className="text-cyan-400 bg-cyber-grid/50 px-2 py-0.5 rounded text-xs break-all">
                      {apiBaseUrl}/v1/dedicated/server/datacenter/availabilities
                    </code>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-cyber-muted min-w-[60px]">区域：</span>
                    <span className="text-slate-300">
                      {endpoint === 'ovh-us' ? '美国 (US)' : endpoint === 'ovh-ca' ? '加拿大 (CA)' : '欧洲 (EU)'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-cyber-muted min-w-[60px]">说明：</span>
                    <span className="text-slate-300">
                      此 API 无需认证，实时返回所有 OVH 专用服务器在各数据中心的库存状态
                    </span>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* 统计卡片 */}
      {availabilities.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="cyber-panel p-2 sm:p-4">
            <div className="flex items-center gap-1 sm:gap-2 text-cyber-muted text-xs sm:text-sm mb-1">
              <Database className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">总记录数</span>
              <span className="sm:hidden">总数</span>
            </div>
            <div className="text-lg sm:text-2xl font-bold text-cyber-accent">{stats.total}</div>
          </div>
          <div className="cyber-panel p-2 sm:p-4">
            <div className="flex items-center gap-1 sm:gap-2 text-cyber-muted text-xs sm:text-sm mb-1">
              <TrendingUp className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">有货服务器</span>
              <span className="sm:hidden">有货</span>
            </div>
            <div className="text-lg sm:text-2xl font-bold text-green-400">{stats.available}</div>
          </div>
          <div className="cyber-panel p-2 sm:p-4">
            <div className="flex items-center gap-1 sm:gap-2 text-cyber-muted text-xs sm:text-sm mb-1">
              <Filter className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">1小时内</span>
              <span className="sm:hidden">1H内</span>
            </div>
            <div className="text-lg sm:text-2xl font-bold text-yellow-400">{stats.oneHour}</div>
          </div>
        </div>
      )}

      {/* 搜索和过滤器 */}
      {availabilities.length > 0 && (
        <div className="cyber-panel p-3 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4">
            {/* 搜索框 */}
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 sm:w-4 sm:h-4 text-cyber-muted" />
              <input
                type="text"
                placeholder={isMobile ? "搜索..." : "搜索服务器、内存、存储..."}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="cyber-input pl-8 sm:pl-10 w-full text-sm"
              />
            </div>
            
            {/* 数据中心过滤 */}
            <select
              value={filterDatacenter}
              onChange={(e) => setFilterDatacenter(e.target.value)}
              className="cyber-input w-full"
            >
              <option value="all">所有数据中心</option>
              <optgroup label="🇪🇺 欧洲">
                <option value="rbx">RBX - 法国鲁贝</option>
                <option value="sbg">SBG - 法国斯特拉斯堡</option>
                <option value="gra">GRA - 法国格拉沃利纳</option>
                <option value="waw">WAW - 波兰华沙</option>
                <option value="fra">FRA - 德国法兰克福</option>
                <option value="lon">LON - 英国伦敦</option>
              </optgroup>
              <optgroup label="🇺🇸 美国">
                <option value="hil">HIL - 美国俄勒冈州</option>
                <option value="vin">VIN - 美国弗吉尼亚州</option>
              </optgroup>
              <optgroup label="🇨🇦 加拿大">
                <option value="bhs">BHS - 加拿大蒙特利尔</option>
              </optgroup>
              <optgroup label="🌏 亚太">
                <option value="sgp">SGP - 新加坡</option>
                <option value="syd">SYD - 澳大利亚悉尼</option>
                <option value="ynm">YNM - 印度孟买</option>
              </optgroup>
            </select>
            
            {/* 可用性过滤 */}
            <select
              value={filterAvailability}
              onChange={(e) => setFilterAvailability(e.target.value)}
              className="cyber-input w-full"
            >
              <option value="all">所有状态</option>
              <option value="available">有货</option>
              <option value="1h">1小时内</option>
              <option value="unavailable">无货</option>
            </select>
            
            {/* 内存过滤 */}
            <select
              value={filterMemory}
              onChange={(e) => setFilterMemory(e.target.value)}
              className="cyber-input w-full"
            >
              <option value="all">所有内存</option>
              <option value="<=128">≤ 128GB</option>
              <option value="256">128GB - 256GB</option>
              <option value="512">256GB - 512GB</option>
              <option value=">=1024">≥ 1TB</option>
            </select>
          </div>
          
          {/* 排序选项 */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-cyber-muted">排序：</span>
            <Button
              onClick={() => {
                if (sortBy === 'planCode') {
                  setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                } else {
                  setSortBy('planCode');
                  setSortOrder('asc');
                }
              }}
              variant="cyber"
              size="sm"
              className={`text-xs ${sortBy === 'planCode' ? 'bg-cyber-accent/20' : ''}`}
            >
              型号 {sortBy === 'planCode' && (sortOrder === 'asc' ? '↑' : '↓')}
            </Button>
            <Button
              onClick={() => {
                if (sortBy === 'memory') {
                  setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                } else {
                  setSortBy('memory');
                  setSortOrder('asc');
                }
              }}
              variant="cyber"
              size="sm"
              className={`text-xs ${sortBy === 'memory' ? 'bg-cyber-accent/20' : ''}`}
            >
              内存 {sortBy === 'memory' && (sortOrder === 'asc' ? '↑' : '↓')}
            </Button>
            <Button
              onClick={() => {
                if (sortBy === 'availability') {
                  setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                } else {
                  setSortBy('availability');
                  setSortOrder('desc');
                }
              }}
              variant="cyber"
              size="sm"
              className={`text-xs ${sortBy === 'availability' ? 'bg-cyber-accent/20' : ''}`}
            >
              可用性 {sortBy === 'availability' && (sortOrder === 'asc' ? '↑' : '↓')}
            </Button>
          </div>
        </div>
      )}

      {/* 数据列表 */}
      {isLoading ? (
        <div className="flex justify-center items-center h-64">
          <div className="text-center">
            <div className="animate-spin w-10 h-10 border-4 border-cyber-accent border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-cyber-muted">正在获取 OVH 实时数据...</p>
          </div>
        </div>
      ) : filteredData.length === 0 && availabilities.length === 0 ? (
        <div className="cyber-panel p-8 text-center">
          <Database className="w-16 h-16 text-cyber-muted mx-auto mb-4 opacity-50" />
          <p className="text-cyber-muted mb-4">暂无数据</p>
          <p className="text-sm text-slate-500">点击"刷新数据"按钮获取 OVH 最新库存信息</p>
        </div>
      ) : filteredData.length === 0 ? (
        <div className="cyber-panel p-8 text-center">
          <Filter className="w-16 h-16 text-cyber-muted mx-auto mb-4 opacity-50" />
          <p className="text-cyber-muted mb-2">没有匹配的结果</p>
          <p className="text-sm text-slate-500">尝试修改搜索或过滤条件</p>
        </div>
      ) : (
        <>
          <div className="space-y-2 sm:space-y-3">
            {paginatedData.map((item, index) => (
              <div
                key={item.fqn || index}
                className="cyber-panel p-3 sm:p-4 hover:border-cyber-accent/50 transition-colors"
              >
              <div className="mb-2 sm:mb-3">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-cyber-accent truncate">{item.planCode}</h3>
                    <p className="text-xs sm:text-sm text-cyber-muted line-clamp-1">{item.server}</p>
                  </div>
                  {!isMobile && (
                    <div className="text-right text-xs text-cyber-muted flex-shrink-0">
                      <div className="font-mono">{item.fqn}</div>
                    </div>
                  )}
                </div>
                
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2 text-xs sm:text-sm">
                  <div>
                    <span className="text-cyber-muted">内存：</span>
                    <span className="text-slate-300 ml-1 sm:ml-2">{item.memory}</span>
                  </div>
                  <div>
                    <span className="text-cyber-muted">存储：</span>
                    <span className="text-slate-300 ml-1 sm:ml-2">{item.storage}</span>
                  </div>
                  {item.systemStorage && (
                    <div>
                      <span className="text-cyber-muted">系统盘：</span>
                      <span className="text-slate-300 ml-1 sm:ml-2">{item.systemStorage}</span>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="cyber-grid-line pt-2 sm:pt-3">
                <h4 className="text-xs font-semibold text-cyber-muted mb-2">
                  数据中心可用性 ({item.datacenters.length} 个)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-1.5 sm:gap-2">
                  {item.datacenters.map((dc) => {
                    const availInfo = getAvailabilityInfo(dc.availability);
                    
                    return (
                      <div
                        key={dc.datacenter}
                        className={`${availInfo.bg} ${availInfo.border} border rounded px-1.5 sm:px-2 py-1 sm:py-1.5 text-xs`}
                      >
                        <div className="font-semibold text-slate-200 text-[10px] sm:text-xs">{dc.datacenter.toUpperCase()}</div>
                        <div className={`${availInfo.color} text-[9px] sm:text-[10px] font-medium`}>
                          {availInfo.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            ))}
          </div>
          
          {/* 分页控件 */}
          {totalPages > 1 && (
            <div className="cyber-panel p-3 sm:p-4 mt-3 sm:mt-4">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4">
                <div className="text-xs sm:text-sm text-cyber-muted">
                  {isMobile ? (
                    <>{currentPage}/{totalPages}</>
                  ) : (
                    <>显示 {((currentPage - 1) * itemsPerPage) + 1} - {Math.min(currentPage * itemsPerPage, filteredData.length)} / 共 {filteredData.length} 条</>
                  )}
                </div>
                
                <div className="flex items-center gap-1.5 sm:gap-2">
                  {!isMobile && (
                    <Button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      variant="cyber"
                      size="sm"
                      className="px-3 text-xs"
                    >
                      首页
                    </Button>
                  )}
                  
                  <Button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    variant="cyber"
                    size="sm"
                    className="px-2"
                  >
                    <ChevronLeft className="w-3 h-3 sm:w-4 sm:h-4" />
                  </Button>
                  
                  <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 bg-cyber-grid/30 rounded text-xs sm:text-sm">
                    <span className="text-cyber-accent font-medium">{currentPage}</span>
                    <span className="text-cyber-muted">/</span>
                    <span className="text-cyber-muted">{totalPages}</span>
                  </div>
                  
                  <Button
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    variant="cyber"
                    size="sm"
                    className="px-2"
                  >
                    <ChevronRight className="w-3 h-3 sm:w-4 sm:h-4" />
                  </Button>
                  
                  {!isMobile && (
                    <Button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      variant="cyber"
                      size="sm"
                      className="px-3 text-xs"
                    >
                      末页
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default OVHAvailabilityPage;
