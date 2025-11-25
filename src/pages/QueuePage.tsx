import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAPI } from "@/context/APIContext";
import { api } from "@/utils/apiClient";
import { toast } from "sonner";
import { XIcon, RefreshCwIcon, PlusIcon, SearchIcon, PlayIcon, PauseIcon, Trash2Icon, ArrowUpDownIcon, HeartIcon, Settings, Cpu, Database, HardDrive, Wifi, ArrowRightLeft, CheckSquare, Check, ShoppingCart, CreditCard } from 'lucide-react';
import { useIsMobile } from "@/hooks/use-mobile";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { 
  API_URL, 
  TASK_RETRY_INTERVAL, 
  MIN_RETRY_INTERVAL,
  QUEUE_POLLING_INTERVAL,
  formatInterval
} from "@/config/constants";
import { OVH_DATACENTERS, DatacenterInfo } from "@/config/ovhConstants";

interface QueueItem {
  id: string;
  planCode: string;
  datacenter?: string;
  datacenters?: string[];
  options: string[];
  status: "pending" | "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  retryInterval: number;
  retryCount: number;
  accountId?: string;
  quantity?: number;
  purchased?: number;
  failureCount?: number;
  nextAttemptAt?: number;
  auto_pay?: boolean;
}

interface ServerOption {
  label: string;
  value: string;
  family?: string;
  isDefault?: boolean;
}

interface ServerPlan {
  planCode: string;
  name: string;
  cpu: string;
  memory: string;
  storage: string;
  datacenters: {
    datacenter: string;
    dcName: string;
    region: string;
    availability: string;
  }[];
  defaultOptions: ServerOption[];
  availableOptions: ServerOption[];
}

const DATACENTER_REGIONS: Record<string, string[]> = {
  '欧洲': ['gra', 'sbg', 'rbx', 'waw', 'fra', 'lon'],
  '北美': ['bhs', 'hil', 'vin'],
  '亚太': ['sgp', 'syd', 'mum'],
};

const QueuePage = () => {
  const isMobile = useIsMobile();
  const { isAuthenticated, accounts } = useAPI();
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [scopeAll, setScopeAll] = useState<boolean>(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false); // 区分初始加载和刷新
  const [showAddForm, setShowAddForm] = useState(true); // 默认展开表单
  const [servers, setServers] = useState<ServerPlan[]>([]);
  const [planCodeInput, setPlanCodeInput] = useState<string>("");
  const [selectedServer, setSelectedServer] = useState<ServerPlan | null>(null);
  const [selectedDatacenters, setSelectedDatacenters] = useState<string[]>([]);
  const [visibleDatacenters, setVisibleDatacenters] = useState<string[] | null>(null);
  
  const [draggingDc, setDraggingDc] = useState<string | null>(null);
  const [retryInterval, setRetryInterval] = useState<number>(TASK_RETRY_INTERVAL);
  const [quantity, setQuantity] = useState<number>(1);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]); // 选中的可选配置
  const [optionsInput, setOptionsInput] = useState<string>(''); // 用户自定义输入
  const [autoPay, setAutoPay] = useState<boolean>(false);
  const [planCodeDebounced, setPlanCodeDebounced] = useState<string>("");
  const [showClearConfirm, setShowClearConfirm] = useState(false); // 清空确认对话框
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [runningItems, setRunningItems] = useState<QueueItem[]>([]);
  const [completedItems, setCompletedItems] = useState<QueueItem[]>([]);
  const [pausedItems, setPausedItems] = useState<QueueItem[]>([]);
  const [runningPage, setRunningPage] = useState<number>(1);
  const [completedPage, setCompletedPage] = useState<number>(1);
  const [pausedPage, setPausedPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [runningTotal, setRunningTotal] = useState<number>(0);
  const [completedTotal, setCompletedTotal] = useState<number>(0);
  const [pausedTotal, setPausedTotal] = useState<number>(0);
  const [runningTotalPages, setRunningTotalPages] = useState<number>(1);
  const [completedTotalPages, setCompletedTotalPages] = useState<number>(1);
  const [pausedTotalPages, setPausedTotalPages] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<'running' | 'completed' | 'paused'>('running');
  const fallbackToastShownRef = useRef(false);

  const getAccountLabel = (id?: string) => {
    if (!id) return '默认账户';
    const acc = accounts.find((a: any) => a?.id === id);
    return acc?.alias || id;
  };

  const getAccountZone = (id?: string) => {
    if (!id) return '';
    const acc = accounts.find((a: any) => a?.id === id);
    return acc?.zone || '';
  };

  // Fetch queue items
  const fetchQueueItems = async (isRefresh = false, scopeOverride?: boolean) => {
    // 如果是刷新，只设置刷新状态，不改变加载状态
    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    try {
      const useScopeAll = scopeOverride !== undefined ? scopeOverride : scopeAll;
      const response = await api.get(`/queue`, { params: { scope: useScopeAll ? 'all' : undefined } });
      setQueueItems(response.data);
      try {
        const baseParams = (extra: any = {}) => ({ scope: useScopeAll ? 'all' : undefined, ...extra });
        const runningResp = await api.get(`/queue/paged`, { params: baseParams({ status: 'running', page: runningPage, pageSize }) });
        const completedResp = await api.get(`/queue/paged`, { params: baseParams({ status: 'completed', page: completedPage, pageSize }) });
        const pausedResp = await api.get(`/queue/paged`, { params: baseParams({ status: 'paused', page: pausedPage, pageSize }) });
        setRunningItems(runningResp.data.items || []);
        setCompletedItems(completedResp.data.items || []);
        setPausedItems(pausedResp.data.items || []);
        setRunningTotal(runningResp.data.total || 0);
        setCompletedTotal(completedResp.data.total || 0);
        setPausedTotal(pausedResp.data.total || 0);
        setRunningTotalPages(runningResp.data.totalPages || 1);
        setCompletedTotalPages(completedResp.data.totalPages || 1);
        setPausedTotalPages(pausedResp.data.totalPages || 1);
      } catch {}
    } catch (error) {
      console.error("Error fetching queue items:", error);
      toast.error("获取队列失败");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  // Fetch servers for the add form
  const fetchServers = async (forceRefresh = false) => {
    try {
      const resCache = await api.get(`/servers`, {
        params: { showApiServers: false, forceRefresh: false },
      });
      let serversList = resCache.data.servers || resCache.data || [];
      if ((!serversList || serversList.length === 0) && isAuthenticated) {
        if (!fallbackToastShownRef.current) {
          fallbackToastShownRef.current = true;
          toast.info('缓存为空，正在从 OVH 拉取服务器列表，首次加载可能需 1–2 分钟', { duration: 4000 });
        }
        const resLive = await api.get(`/servers`, {
          params: { showApiServers: true, forceRefresh: true },
        });
        serversList = resLive.data.servers || resLive.data || [];
        if (serversList && serversList.length > 0) {
          toast.success('服务器列表已从 OVH 更新');
        }
      }
      setServers(serversList);
      return serversList;
    } catch (error) {
      console.error("Error fetching servers:", error);
      toast.error("获取服务器列表失败");
      return [];
    }
  };

  // Add new queue item
  const addQueueItem = async () => {
    if (!planCodeInput.trim() || selectedDatacenters.length === 0) {
      toast.error("请输入服务器计划代码并至少选择一个数据中心");
      return;
    }

    if (quantity < 1 || quantity > 100) {
      toast.error("抢购数量必须在 1-100 之间");
      return;
    }


    if (retryInterval <= 0) {
      toast.error("重试间隔必须大于 0 秒");
      return;
    }

    try {
      await api.post(`/queue`, {
        planCode: planCodeInput.trim(),
        datacenters: selectedDatacenters,
        retryInterval: retryInterval,
        options: selectedOptions,
        quantity: quantity,
        auto_pay: autoPay,
        accountId: selectedAccountId || undefined,
      });
      toast.success(`已创建抢购任务，目标 ${quantity} 台`);
      fetchQueueItems(true);
      setPlanCodeInput("");
      setSelectedDatacenters([]);
      setRetryInterval(TASK_RETRY_INTERVAL);
      setQuantity(1);
      setSelectedOptions([]);
      setOptionsInput('');
      setAutoPay(false);
    } catch (error) {
      console.error(`Error adding ${planCodeInput.trim()} to queue:`, error);
      toast.error("添加到队列失败");
    }
  };

  const beginEditQueueItem = async (item: any) => {
    setShowAddForm(true);
    setEditingItemId(item.id);
    setPlanCodeInput(item.planCode || '');
    setSelectedAccountId(item.accountId || '');
    setRetryInterval(item.retryInterval || TASK_RETRY_INTERVAL);
    setQuantity(Math.min(Math.max(item.quantity || 1, 1), 100));
    setSelectedOptions(Array.isArray(item.options) ? item.options : []);
    setOptionsInput((Array.isArray(item.options) ? item.options : []).join(', '));
    setAutoPay(!!item.auto_pay);
    setTimeout(() => {
      if (Array.isArray(item.datacenters)) {
        setSelectedDatacenters(item.datacenters);
      }
    }, 50);
    setTimeout(() => {
      const el = document.getElementById(`queue-item-${item.id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    toast.info('已载入该队列的配置，可在上方修改');
  };

  const updateQueueItem = async () => {
    if (!editingItemId) return;
    if (!planCodeInput.trim() || selectedDatacenters.length === 0) {
      toast.error('请输入服务器计划代码并至少选择一个数据中心');
      return;
    }
    try {
      await api.put(`/queue/${editingItemId}`, {
        planCode: planCodeInput.trim(),
        datacenters: selectedDatacenters,
        retryInterval,
        options: selectedOptions,
        quantity,
        auto_pay: autoPay,
        accountId: selectedAccountId || undefined,
      });
      toast.success('队列已更新');
      setEditingItemId(null);
      setPlanCodeInput("");
      fetchQueueItems(true);
    } catch (error) {
      console.error('更新队列失败', error);
      toast.error('更新队列失败');
    }
  };

  // Remove queue item
  const removeQueueItem = async (id: string) => {
    try {
      await api.delete(`/queue/${id}`);
      toast.success("已从队列中移除");
      fetchQueueItems(true);
    } catch (error) {
      console.error("Error removing queue item:", error);
      toast.error("从队列中移除失败");
    }
  };

  // Start/stop queue item
  const toggleQueueItemStatus = async (id: string, currentStatus: string) => {
    // 优化状态切换逻辑：
    // running → paused (暂停运行中的任务)
    // paused → running (恢复已暂停的任务)
    // pending/completed/failed → running (启动其他状态的任务)
    let newStatus: string;
    let actionText: string;
    
    if (currentStatus === "running") {
      newStatus = "paused";
      actionText = "暂停";
    } else if (currentStatus === "paused") {
      newStatus = "running";
      actionText = "恢复";
    } else {
      newStatus = "running";
      actionText = "启动";
    }
    
    try {
      await api.put(`/queue/${id}/status`, {
        status: newStatus,
      });
      
      toast.success(`已${actionText}队列项`);
      fetchQueueItems(true);
    } catch (error) {
      console.error("Error updating queue item status:", error);
      toast.error("更新队列项状态失败");
    }
  };

  // Clear all queue items
  const clearAllQueue = async () => {
    try {
      const response = await api.delete(`/queue/clear`, { params: { scope: scopeAll ? 'all' : undefined } });
      const cnt = response.data?.count ?? 0;
      const accCnt = response.data?.accountCount ?? (scopeAll ? '多个' : 1);
      toast.success(scopeAll 
        ? `已清空全部账户队列（共 ${cnt} 项，涉及 ${accCnt} 个账户）`
        : `已清空当前账户队列（共 ${cnt} 项）`
      );
      fetchQueueItems(true);
      setShowClearConfirm(false);
    } catch (error) {
      console.error("Error clearing queue:", error);
      toast.error("清空队列失败");
      setShowClearConfirm(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchQueueItems();
    (async () => {
      await fetchServers(false);
    })();
    return () => void 0;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const runningResp = await api.get(`/queue/paged`, { params: { status: 'running', page: runningPage, pageSize, scope: scopeAll ? 'all' : undefined } });
        setRunningItems(runningResp.data.items || []);
        setRunningTotal(runningResp.data.total || 0);
        setRunningTotalPages(runningResp.data.totalPages || 1);
      } catch {}
    })();
  }, [runningPage, pageSize, scopeAll]);

  useEffect(() => {
    (async () => {
      try {
        const completedResp = await api.get(`/queue/paged`, { params: { status: 'completed', page: completedPage, pageSize, scope: scopeAll ? 'all' : undefined } });
        setCompletedItems(completedResp.data.items || []);
        setCompletedTotal(completedResp.data.total || 0);
        setCompletedTotalPages(completedResp.data.totalPages || 1);
      } catch {}
    })();
  }, [completedPage, pageSize, scopeAll]);

  useEffect(() => {
    (async () => {
      try {
        const pausedResp = await api.get(`/queue/paged`, { params: { status: 'paused', page: pausedPage, pageSize, scope: scopeAll ? 'all' : undefined } });
        setPausedItems(pausedResp.data.items || []);
        setPausedTotal(pausedResp.data.total || 0);
        setPausedTotalPages(pausedResp.data.totalPages || 1);
      } catch {}
    })();
  }, [pausedPage, pageSize, scopeAll]);

  useEffect(() => {
    const t = setTimeout(() => {
      setPlanCodeDebounced(planCodeInput.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [planCodeInput]);

  // Update selectedServer and visible datacenters when planCodeInput or servers list changes
  useEffect(() => {
    if (planCodeDebounced) {
      const server = servers.find(s => s.planCode === planCodeDebounced);
      setSelectedServer(server || null);
      if (server && Array.isArray(server.datacenters)) {
        const dcList = server.datacenters
          .map(d => d.datacenter?.toLowerCase())
          .map(d => (d === 'ynm' ? 'mum' : d))
          .filter(Boolean) as string[];
        const validDcs = OVH_DATACENTERS.map(dc => dc.code);
        const filtered = dcList.filter(dc => validDcs.includes(dc));
        const uniqueFiltered = Array.from(new Set(filtered));
        setVisibleDatacenters(uniqueFiltered);
        if (!editingItemId) {
          setSelectedDatacenters([]);
          const defaults = (server.defaultOptions || []).map(o => o.value);
          if (defaults.length > 0 && selectedOptions.length === 0) {
            setSelectedOptions(prev => {
              const set = new Set([...prev, ...defaults]);
              return Array.from(set);
            });
          }
          setOptionsInput('');
        }
      } else {
        setVisibleDatacenters([]);
        if (!editingItemId) {
          setSelectedDatacenters([]);
          setSelectedOptions([]);
          setOptionsInput('');
        }
        
      }
    } else {
      setSelectedServer(null);
      setVisibleDatacenters([]);
      if (!editingItemId) {
        setSelectedDatacenters([]);
        setSelectedOptions([]);
        setOptionsInput('');
      }
    }
  }, [planCodeDebounced, servers, editingItemId, selectedOptions.length]);

  // 不自动重置选项 - 用户可能只是修改了 planCode，应保留已选配置
  
  // 双向同步：输入框 ↔ selectedOptions
  useEffect(() => {
    setOptionsInput(selectedOptions.join(', '));
  }, [selectedOptions]);
  
  // 从输入框更新到数组
  const updateOptionsFromInput = () => {
    const options = optionsInput
      .split(',')
      .map(v => v.trim())
      .filter(v => v);
    setSelectedOptions(options);
  };

  const filterHardwareOptions = (opts: ServerOption[]) => {
    if (!opts) return [];
    return opts.filter(option => {
      const optionValue = option.value.toLowerCase();
      const optionLabel = option.label.toLowerCase();
      if (
        optionValue.includes("windows-server") ||
        optionValue.includes("sql-server") ||
        optionValue.includes("cpanel-license") ||
        optionValue.includes("plesk-") ||
        optionValue.includes("-license-") ||
        optionValue.startsWith("os-") ||
        optionValue.includes("control-panel") ||
        optionValue.includes("panel") ||
        optionLabel.includes("license") ||
        optionLabel.includes("许可证") ||
        optionLabel.includes("许可") ||
        optionValue.includes("security") ||
        optionValue.includes("antivirus") ||
        optionValue.includes("firewall")
      ) {
        return false;
      }
      return true;
    });
  };

  const buildOptionGroups = (opts: ServerOption[]) => {
    const optionGroups: Record<string, ServerOption[]> = {
      "CPU/处理器": [],
      "内存": [],
      "存储": [],
      "带宽/网络": [],
      "vRack内网": [],
      "其他": []
    };
    opts.forEach(option => {
      const family = option.family?.toLowerCase() || "";
      const desc = option.label.toLowerCase();
      const value = option.value.toLowerCase();
      if (family.includes("cpu") || family.includes("processor") || 
          desc.includes("cpu") || desc.includes("processor") || 
          desc.includes("intel") || desc.includes("amd") || 
          desc.includes("xeon") || desc.includes("epyc") || 
          desc.includes("ryzen") || desc.includes("core")) {
        optionGroups["CPU/处理器"].push(option);
      } else if (family.includes("memory") || family.includes("ram") || 
                 desc.includes("ram") || desc.includes("memory") || 
                 desc.includes("gb") || desc.includes("ddr")) {
        optionGroups["内存"].push(option);
      } else if (family.includes("storage") || family.includes("disk") || 
                 desc.includes("ssd") || desc.includes("hdd") || 
                 desc.includes("nvme") || desc.includes("storage") || 
                 desc.includes("disk") || desc.includes("raid")) {
        optionGroups["存储"].push(option);
      } else if (value.includes("vrack") || desc.includes("vrack") || 
                 desc.includes("内网") || family.includes("vrack")) {
        optionGroups["vRack内网"].push(option);
      } else if (family.includes("bandwidth") || family.includes("traffic") || 
                 desc.includes("bandwidth") || desc.includes("network") || 
                 desc.includes("ip") || desc.includes("带宽") || 
                 desc.includes("mbps") || desc.includes("gbps")) {
        optionGroups["带宽/网络"].push(option);
      } else {
        optionGroups["其他"].push(option);
      }
    });
    return optionGroups;
  };

  const formatOptionDisplay = (option: ServerOption, groupName: string) => {
    let displayLabel = option.label;
    let detailLabel = option.value;
    if (groupName === "内存" && option.value.includes("ram-")) {
      const ramMatch = option.value.match(/ram-(\d+)g/i);
      if (ramMatch) {
        displayLabel = `${ramMatch[1]} GB`;
      }
    }
    if (groupName === "存储" && (option.value.includes("raid") || option.value.includes("ssd") || option.value.includes("hdd") || option.value.includes("nvme"))) {
      const hybridRaidMatch = option.value.match(/hybridsoftraid-(\d+)x(\d+)(sa|ssd|hdd)-(\d+)x(\d+)(nvme|ssd|hdd)/i);
      if (hybridRaidMatch) {
        const count1 = hybridRaidMatch[1];
        const size1 = hybridRaidMatch[2];
        const type1 = hybridRaidMatch[3].toUpperCase();
        const count2 = hybridRaidMatch[4];
        const size2 = hybridRaidMatch[5];
        const type2 = hybridRaidMatch[6].toUpperCase();
        displayLabel = `混合RAID ${count1}x ${size1}GB ${type1} + ${count2}x ${size2}GB ${type2}`;
      } else {
        const storageMatch = option.value.match(/(raid|softraid)-(\d+)x(\d+)(sa|ssd|hdd|nvme)/i);
        if (storageMatch) {
          const raidType = storageMatch[1].toUpperCase();
          const count = storageMatch[2];
          const size = storageMatch[3];
          const diskType = storageMatch[4].toUpperCase();
          displayLabel = `${raidType} ${count}x ${size}GB ${diskType}`;
        }
      }
    }
    if (groupName === "带宽/网络" && (option.value.includes("bandwidth") || option.value.includes("traffic"))) {
      const bwMatch = option.value.match(/bandwidth-(\d+)/i);
      if (bwMatch) {
        const speed = parseInt(bwMatch[1]);
        displayLabel = speed >= 1000 ? `${speed/1000} Gbps` : `${speed} Mbps`;
      }
      const combinedTrafficMatch = option.value.match(/traffic-(\d+)(tb|gb|mb)-(\d+)/i);
      if (combinedTrafficMatch) {
        const trafficSize = combinedTrafficMatch[1];
        const trafficUnit = combinedTrafficMatch[2].toUpperCase();
        const bandwidth = combinedTrafficMatch[3];
        displayLabel = `${bandwidth} Mbps / ${trafficSize} ${trafficUnit}流量`;
      } else {
        const trafficMatch = option.value.match(/traffic-(\d+)(tb|gb)/i);
        if (trafficMatch) {
          displayLabel = `${trafficMatch[1]} ${trafficMatch[2].toUpperCase()} 流量`;
        }
      }
      if (option.value.toLowerCase().includes("unlimited")) {
        displayLabel = `无限流量`;
      }
    }
    if (groupName === "vRack内网") {
      const vrackBwMatch = option.value.match(/vrack-bandwidth-(\d+)/i);
      if (vrackBwMatch) {
        const speed = parseInt(vrackBwMatch[1]);
        displayLabel = speed >= 1000 ? `${speed/1000} Gbps 内网带宽` : `${speed} Mbps 内网带宽`;
      }
      if (option.value.toLowerCase().includes("vrack") && !option.value.toLowerCase().includes("bandwidth")) {
        displayLabel = `vRack ${option.label}`;
      }
    }
    return { displayLabel, detailLabel };
  };

  const isOptionSelectedValue = (optionValue: string): boolean => {
    return selectedOptions.includes(optionValue);
  };

  const toggleOptionValue = (optionValue: string, groupName?: string) => {
    setSelectedOptions(prev => {
      let currentOptions = [...prev];
      const index = currentOptions.indexOf(optionValue);
      if (index >= 0) {
        currentOptions.splice(index, 1);
      } else {
        if (groupName && selectedServer) {
          const grouped = buildOptionGroups(filterHardwareOptions(selectedServer.availableOptions || []));
          const sameGroup = grouped[groupName] || [];
          const sameGroupValues = new Set(sameGroup.map(o => o.value));
          currentOptions = currentOptions.filter(v => !sameGroupValues.has(v));
        }
        currentOptions.push(optionValue);
      }
      setOptionsInput(currentOptions.join(', '));
      return currentOptions;
    });
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { 
      opacity: 1,
      transition: { 
        staggerChildren: 0.05
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 }
  };

  const handleDatacenterChange = (dcCode: string) => {
    setSelectedDatacenters(prev => {
      if (prev.includes(dcCode)) {
        return prev.filter(d => d !== dcCode);
      } else {
        return [...prev, dcCode];
      }
    });
  };

  // 全选数据中心
  const selectAllDatacenters = () => {
    const base = (visibleDatacenters && visibleDatacenters.length > 0)
      ? visibleDatacenters
      : OVH_DATACENTERS.map(dc => dc.code);
    const allDcCodes = Array.from(new Set(base));
    setSelectedDatacenters(allDcCodes);
  };

  // 取消全选数据中心
  const deselectAllDatacenters = () => {
    setSelectedDatacenters([]);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className={`${isMobile ? 'text-2xl' : 'text-3xl'} font-bold mb-1 cyber-glow-text`}>抢购队列</h1>
        <p className="text-cyber-muted text-sm mb-4 sm:mb-6">管理自动抢购服务器的队列</p>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 mb-4 sm:mb-6">
        <button
          onClick={() => fetchQueueItems(true)}
          className="cyber-button text-xs flex items-center justify-center"
          disabled={isLoading || isRefreshing}
        >
          <RefreshCwIcon size={12} className={`mr-1 flex-shrink-0 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="min-w-[2.5rem]">刷新</span>
        </button>
        <button
          onClick={() => setShowClearConfirm(true)}
          className="cyber-button text-xs flex items-center bg-red-900/30 border-red-700/40 text-red-300 hover:bg-red-800/40 hover:border-red-600/50 hover:text-red-200 justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={isLoading || queueItems.length === 0}
        >
          <Trash2Icon size={12} className="mr-1" />
          {!isMobile && '清空队列'}
          {isMobile && '清空'}
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="bg-cyber-surface-dark p-4 sm:p-6 rounded-lg shadow-xl border border-cyber-border">
          <div className="flex items-center justify-between mb-4 sm:mb-6">
            <h2 className={`${isMobile ? 'text-lg' : 'text-xl'} font-semibold text-cyber-primary-accent`}>
              {editingItemId ? '正在编辑队列项' : '添加抢购任务'}
            </h2>
            <div className="flex items-center gap-2">
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="text-xs px-2 py-1 rounded border border-cyber-border bg-cyber-grid/10"
                title="选择账户"
              >
                <option value="">当前账户</option>
                {accounts.map((a: any) => (
                  <option key={a.id} value={a.id}>{a.alias || a.id}</option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="space-y-4 sm:space-y-6 mb-4 sm:mb-6">
            <div className="flex flex-col md:flex-row md:items-end gap-3">
              <div className="md:flex-1">
                <label htmlFor="planCode" className="block text-sm font-medium text-cyber-secondary mb-1">服务器计划代码</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    id="planCode"
                    value={planCodeInput}
                    onChange={(e) => setPlanCodeInput(e.target.value)}
                    placeholder="例如: 24sk202"
                    className="flex-1 cyber-input bg-cyber-surface text-cyber-text border-cyber-border focus:ring-cyber-primary focus:border-cyber-primary"
                  />
                  
                </div>
              </div>
              <div className="md:w-[220px]">
                <label htmlFor="quantity" className="block text-sm font-medium text-cyber-secondary mb-1">抢购单量</label>
                <input
                  type="number"
                  id="quantity"
                  value={quantity}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (value >= 1 && value <= 100) {
                      setQuantity(value);
                    } else {
                      toast.warning("抢购数量必须在 1-100 之间");
                    }
                  }}
                  min={1}
                  max={100}
                  className="w-full cyber-input bg-cyber-surface text-cyber-text border-cyber-border focus:ring-cyber-primary focus:border-cyber-primary"
                  placeholder="默认: 1台"
                />
              </div>
              
              <div className="md:w-[260px]">
                <label htmlFor="retryInterval" className="block text-sm font-medium text-cyber-secondary mb-1">抢购失败后重试间隔 (秒)</label>
                <input
                  type="number"
                  id="retryInterval"
                  value={retryInterval}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (value > 0 || e.target.value === '') {
                      setRetryInterval(value > 0 ? value : 0);
                    }
                  }}
                  min={0}
                  step={1}
                  className={`w-full cyber-input bg-cyber-surface text-cyber-text border-cyber-border focus:ring-cyber-primary focus:border-cyber-primary ${retryInterval > 0 && retryInterval < MIN_RETRY_INTERVAL ? 'border-yellow-500' : ''}`}
                  placeholder={`推荐: ${TASK_RETRY_INTERVAL}秒`}
                />
                {retryInterval > 0 && retryInterval < MIN_RETRY_INTERVAL && (
                  <p className="text-xs text-yellow-400 mt-1">⚠️ 间隔时间过短可能导致API过载，建议设置为 {TASK_RETRY_INTERVAL} 秒或更长</p>
                )}
                {retryInterval <= 0 && (
                  <p className="text-xs text-red-400 mt-1">⚠️ 重试间隔必须大于 0</p>
                )}
              </div>
              <div className="md:w-[180px]">
                <label className="block text-sm font-medium text-cyber-secondary mb-1">自动支付</label>
                <div className="flex items-center justify-between bg-cyber-surface border border-cyber-border rounded-md px-3 py-2">
                  <span className="text-xs text-cyber-muted">使用首选支付方式</span>
                  <Switch checked={autoPay} onCheckedChange={setAutoPay} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              <div>
                {(visibleDatacenters && visibleDatacenters.length > 0) && (
                <div className="rounded-md overflow-hidden border border-cyber-accent/20">
                  <div className="px-2 py-1 bg-cyber-grid/20 border-b border-cyber-accent/20 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1 text-cyber-accent"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4l3 3"></path></svg>
                    <span className="text-[12px] font-medium">选择部署位置</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button type="button" onClick={selectAllDatacenters} className="text-[10px] text-cyber-muted hover:text-cyber-accent">全选</button>
                      <button type="button" onClick={deselectAllDatacenters} className="text-[10px] text-cyber-muted hover:text-cyber-accent"><span className="hidden sm:inline">取消全选</span><span className="sm:hidden">取消</span></button>
                    </div>
                  </div>
                  <div className="bg-cyber-grid/5 p-3 sm:p-4 overflow-hidden">
                    {Object.entries(DATACENTER_REGIONS).map(([region, dcCodes]) => {
                      const list = dcCodes.filter(code => (visibleDatacenters || []).includes(code));
                      if (list.length === 0) return null;
                      return (
                        <div key={region} className="mb-5 last:mb-0">
                          <h3 className="text-[12px] font-semibold text-blue-500 mb-3 tracking-wide drop-shadow-[0_0_1px_rgba(59,130,246,0.5)]">{region}</h3>
                          <div className="grid grid-cols-2 gap-3 w-full">
                            {list.map(code => {
                              const dcObj = OVH_DATACENTERS.find(d => d.code === code);
                              const isSelected = selectedDatacenters.includes(code);
                              const dcCodeUpper = code.toUpperCase();
                              return (
                                <button
                                  key={code}
                                  type="button"
                                  className={`w-full px-2.5 py-2 rounded-md transition-all duration-200 flex flex-col items-start min-w-0 ${isSelected ? 'bg-cyber-accent/15 border border-cyber-accent/30' : 'bg-cyber-grid/30 border border-cyber-accent/25 hover:bg-cyber-accent/8 hover:border-cyber-accent/40'}`}
                                  onClick={() => handleDatacenterChange(code)}
                                  title={`${dcObj?.name || dcCodeUpper}`}
                                >
                                  <div className="flex items-center justify-between w-full mb-1.5 gap-2">
                                    <span className="text-[11px] font-bold tracking-wide leading-none text-white transition-colors duration-200">{dcCodeUpper}</span>
                                    <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">{isSelected ? (<Check className="w-4 h-4 text-green-400" strokeWidth={3} />) : (<span className={`w-[6px] h-[6px] rounded-full bg-yellow-400 transition-all duration-200`}></span>)}</div>
                                  </div>
                                  <div className="w-full min-w-0 flex-1 flex items-center"><span className="text-[10px] leading-[1.35] break-words font-normal text-white/90 transition-colors duration-200">{dcObj?.region} - {dcObj?.name}</span></div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}
                {selectedDatacenters.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs font-medium text-cyber-secondary mb-2">拖动标签以设置优先级（越靠前优先级越高）</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedDatacenters.map((dc) => (
                        <div key={dc} draggable onDragStart={() => setDraggingDc(dc)} onDragEnd={() => setDraggingDc(null)} onDragOver={(e) => { e.preventDefault(); if (!draggingDc || draggingDc === dc) return; setSelectedDatacenters(prev => { const from = prev.indexOf(draggingDc); const to = prev.indexOf(dc); if (from === -1 || to === -1) return prev; const next = [...prev]; next.splice(from, 1); next.splice(to, 0, draggingDc); return next; }); }} className={`px-3 py-1.5 text-xs rounded-md border-2 bg-cyber-accent/10 border-cyber-accent/40 text-cyber-accent cursor-move shadow-sm ${draggingDc === dc ? 'opacity-70' : ''}`} title="拖动以调整优先级">{dc.toUpperCase()}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                {selectedServer && selectedServer.availableOptions && selectedServer.availableOptions.length > 0 && (() => {
                  const filteredOptions = filterHardwareOptions(selectedServer.availableOptions || []);
                  const filteredDefaultOptions = filterHardwareOptions(selectedServer.defaultOptions || []);
                  if (filteredOptions.length === 0 && filteredDefaultOptions.length === 0) return null;
                  const defaultSet = new Set(filteredDefaultOptions.map(opt => opt.value));
                  const optionSet = new Set(filteredOptions.map(opt => opt.value));
                  let optionsIdentical = false;
                  if (defaultSet.size === optionSet.size && [...defaultSet].every(v => optionSet.has(v))) { optionsIdentical = true; }
                  const optionGroups = buildOptionGroups(filteredOptions);
                  const hasGroupedOptions = Object.values(optionGroups).some(group => group.length > 0);
                  return (
                    <div className="space-y-2">

                      {!optionsIdentical && hasGroupedOptions && (
                        <div className="rounded-md overflow-hidden border border-cyber-accent/20">
                          <div className="px-2 py-1 bg-cyber-grid/20 border-b border-cyber-accent/20 flex items-center">
                            <Settings size={11} className="mr-1 text-cyber-accent" />
                            <span className="text-[12px] font-medium">自定义配置</span>
                            <div className="ml-auto flex items-center gap-2">
                              <button type="button" onClick={() => { const defaults = (selectedServer?.defaultOptions || []).map(o => o.value); setSelectedOptions(defaults); setOptionsInput(defaults.join(', ')); }} className="text-[10px] text-cyber-muted hover:text-cyber-accent">使用默认配置</button>
                              <button type="button" onClick={() => { setSelectedOptions([]); setOptionsInput(''); }} className="text-[10px] text-cyber-muted hover:text-cyber-accent">清空选择</button>
                            </div>
                          </div>
                          <div className="divide-y divide-cyber-accent/10">
                            {Object.entries(optionGroups).map(([groupName, options]) => {
                              if (options.length === 0) return null;
                              let GroupIcon = Settings; if (groupName === "CPU/处理器") GroupIcon = Cpu; else if (groupName === "内存") GroupIcon = Database; else if (groupName === "存储") GroupIcon = HardDrive; else if (groupName === "带宽/网络") GroupIcon = Wifi; else if (groupName === "vRack内网") GroupIcon = ArrowRightLeft;
                              return (
                                <div key={groupName} className="p-1.5">
                                  <div className="font-medium text-[10px] mb-1 flex items-center text-cyber-accent"><GroupIcon size={11} className="mr-0.5" />{groupName}</div>
                                  <div className="space-y-0.5 pl-0.5">
                                    {options.map(option => {
                                      const { displayLabel, detailLabel } = formatOptionDisplay(option, groupName);
                                      const isSelected = isOptionSelectedValue(option.value);
                                      return (
                                        <div key={option.value} className="flex items-center">
                                          <label className={`flex items-center justify-between px-1.5 py-1 rounded cursor-pointer transition-colors w-full ${isSelected ? 'bg-cyber-accent/15 border border-cyber-accent/30' : 'hover:bg-cyber-grid/10 border border-transparent'}`}>
                                            <div className="flex items-center min-w-0">
                                              <div className="relative mr-1 flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                                                <input type="checkbox" checked={isSelected} onChange={() => toggleOptionValue(option.value, groupName)} className="opacity-0 absolute w-full h-full cursor-pointer" />
                                                <div className={`w-3.5 h-3.5 border rounded-sm flex items-center justify-center ${isSelected ? 'border-cyber-accent bg-cyber-accent/30' : 'border-slate-500'}`}>{isSelected && (<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-cyber-accent"><polyline points="20 6 9 17 4 12"></polyline></svg>)}</div>
                                              </div>
                                              <div className="flex flex-col min-w-0"><span className="text-[11px] font-medium truncate">{displayLabel}</span><span className="text-[9px] text-cyber-muted font-mono truncate">{detailLabel}</span></div>
                                            </div>
                                          </label>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {selectedOptions.length > 0 && (
                        <div className="mt-2 p-2.5 bg-cyber-accent/10 border border-cyber-accent/30 rounded-md">
                          <div className="text-[10px] font-medium text-cyber-accent mb-1.5 flex items-center"><CheckSquare size={10} className="mr-0.5" />已选配置</div>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedOptions.map(optValue => {
                              const option = (selectedServer.availableOptions || []).find(o => o.value === optValue) || (selectedServer.defaultOptions || []).find(o => o.value === optValue);
                              if (!option) return null;
                              let groupName = "其他";
                              const groups = buildOptionGroups(filterHardwareOptions(selectedServer.availableOptions || []));
                              for (const [name, group] of Object.entries(groups)) { if (group.some(o => o.value === optValue)) { groupName = name; break; } }
                              const { displayLabel } = formatOptionDisplay(option, groupName);
                              return (
                                <div key={optValue} className="px-1.5 py-0.5 bg-cyber-accent/20 rounded text-[9px] flex items-center">
                                  {displayLabel}
                                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleOptionValue(optValue); }} className="ml-1 text-cyber-muted hover:text-cyber-accent">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            </div>
            <div className="mt-4">
              {editingItemId ? (
                <div className="flex flex-col md:flex-row gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingItemId(null);
                      setPlanCodeInput("");
                      setSelectedDatacenters([]);
                      setSelectedOptions([]);
                      setOptionsInput('');
                    }}
                    className="cyber-button w-full md:flex-1 px-4 py-2.5"
                  >
                    取消编辑
                  </button>
                  <button
                    onClick={() => updateQueueItem()}
                    className="cyber-button w-full md:flex-1 bg-cyber-primary hover:bg-cyber-primary-dark text-white font-semibold py-2.5"
                    disabled={!planCodeInput.trim() || selectedDatacenters.length === 0}
                  >
                    修改队列
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => addQueueItem()}
                  className="w-full cyber-button bg-cyber-primary hover:bg-cyber-primary-dark text-white font-semibold py-2.5"
                  disabled={!planCodeInput.trim() || selectedDatacenters.length === 0}
                >
                  {selectedDatacenters.length > 0 ? `添加到队列（目标 ${quantity} 台${selectedOptions.length > 0 ? `，含${selectedOptions.length}个可选配置` : ''}）` : '添加到队列'}
                </button>
              )}
            </div>
          </div>
      )}

      {/* Queue List */}
      <div>
        {/* 只在首次加载时显示加载状态，刷新时保留列表 */}
        {isLoading && queueItems.length === 0 ? (
          <div className="cyber-card">
            <div className="flex items-center justify-center py-12">
              <RefreshCwIcon className="w-8 h-8 animate-spin text-cyber-accent" />
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'running' | 'completed' | 'paused')} className="w-full">
                <TabsList className="grid w-full grid-cols-3 cyber-card">
                  <TabsTrigger value="running" className="data-[state=active]:bg-cyber-accent/20">正在进行</TabsTrigger>
                  <TabsTrigger value="paused" className="data-[state=active]:bg-cyber-accent/20">已暂停</TabsTrigger>
                  <TabsTrigger value="completed" className="data-[state=active]:bg-cyber-accent/20">已完成</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="mt-2 flex items-center justify-end">
                <div
                  className="relative inline-flex items-center bg-cyber-grid/10 border border-cyber-border rounded-full h-8 px-3"
                  role="group"
                  aria-label="查看范围切换"
                >
                  <button
                    className={`relative z-10 text-[11px] px-4 py-1.5 leading-none rounded-full transition-colors ${!scopeAll ? 'text-cyber-bg' : 'text-cyber-text'}`}
                    onClick={() => { if (scopeAll) { setScopeAll(false); fetchQueueItems(true, false); } }}
                    title="只看当前账户"
                  >当前账户</button>
                  <button
                    className={`relative z-10 text-[11px] px-4 py-1.5 leading-none rounded-full transition-colors ${scopeAll ? 'text-cyber-bg' : 'text-cyber-text'}`}
                    onClick={() => { if (!scopeAll) { setScopeAll(true); fetchQueueItems(true, true); } }}
                    title="查看全部账户"
                  >全部账户</button>
                  <span
                    className={`absolute top-1 bottom-1 left-1 transition-all duration-200 rounded-full bg-cyber-accent ${scopeAll ? 'translate-x-[84px] w-[88px]' : 'translate-x-0 w-[88px]'}`}
                  />
                </div>
              </div>
            </div>
            {activeTab === 'running' && (
            <Card className="cyber-card">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <span className="text-sm font-semibold text-cyber-text">正在进行</span>
                  <span className="ml-2 text-xs text-cyber-muted">共 {runningTotal} 项</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {runningItems.map(item => (
                  <div 
                    key={item.id}
                    id={`queue-item-${item.id}`}
                    className={`relative bg-cyber-surface p-4 rounded-lg shadow-md border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 ${editingItemId === item.id ? 'border-cyber-accent/60 ring-2 ring-cyber-accent/30 bg-cyber-accent/5 shadow-[0_0_16px_rgba(56,189,248,0.25)]' : 'border-cyber-border'}`}
                  >
                    {editingItemId === item.id && (
                      <span className="pointer-events-none absolute inset-0 rounded-lg animate-pulse bg-cyber-accent/5"></span>
                    )}
                    <div className="flex-grow">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{item.planCode}</span>
                        
                        {(() => {
                          const s = servers.find(ss => ss.planCode === item.planCode);
                          const name = s?.name;
                          if (!name) return null;
                          return (
                            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{name}</span>
                          );
                        })()}
                        {(() => {
                          const list = Array.isArray(item.datacenters) && item.datacenters.length > 0 ? item.datacenters : (item.datacenter ? [item.datacenter] : []);
                          if (list.length > 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list.map(dc => dc.toUpperCase()).join(' › ')}</span>
                            );
                          }
                          if (list.length === 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list[0].toUpperCase()}</span>
                            );
                          }
                          return null;
                        })()}
                        {Array.isArray(item.options) && item.options.length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">含 {item.options.length} 个可选配置</span>
                        )}
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center gap-1">
                          <ShoppingCart size={12} /> {Math.min(item.purchased || 0, item.quantity || 0)} / {item.quantity || 0}
                        </span>
                        {item.auto_pay && (
                          <span className="px-1.5 py-0.5 h-[18px] text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center justify-center gap-1 leading-none" title="自动支付">
                            <CreditCard size={12} className="text-cyber-text" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-cyber-muted">
                        {(() => {
                          const now = Date.now() / 1000;
                          const next = typeof item.nextAttemptAt === 'number' ? item.nextAttemptAt : 0;
                          if (item.status !== 'running') return `状态: ${item.status} | 创建于: ${new Date(item.createdAt || Date.now()).toLocaleString()}`;
                          if (!next || next <= now) return `下次尝试: 即将开始 | 创建于: ${new Date(item.createdAt || Date.now()).toLocaleString()}`;
                          const diff = Math.max(0, Math.round(next - now));
                          return `下次尝试: ${diff} 秒后 (第${(item.retryCount || 0) + 1}次) | 创建于: ${new Date(item.createdAt || Date.now()).toLocaleString()}`;
                        })()}
                      </p>
                      {Array.isArray(item.options) && item.options.length > 0 && (
                        <p className="text-xs text-cyber-muted mt-1">📦 可选配置: {item.options.join(', ')}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 sm:mt-0 flex-shrink-0">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 rounded-md">账户：{getAccountLabel(item.accountId)}</span>
                      {(() => {
                        const zone = getAccountZone(item.accountId);
                        if (!zone) return null;
                        return (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">
                            {zone}
                          </span>
                        );
                      })()}
                      <span className={`text-xs px-2 py-1 rounded-full font-medium bg-green-500/20 text-green-400`}>运行中</span>
                      <button 
                        onClick={() => toggleQueueItemStatus(item.id, item.status)}
                        className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-cyber-primary transition-colors"
                        title={item.status === 'running' ? "暂停" : "启动"}
                      >
                        {item.status === 'running' ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                      </button>
                      <button
                        onClick={() => beginEditQueueItem(item)}
                        className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-cyber-primary transition-colors"
                        title="编辑"
                      >
                        <Settings size={16} />
                      </button>
                      <button 
                        onClick={() => removeQueueItem(item.id)}
                        className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-red-500 transition-colors"
                        title="移除"
                      >
                        <Trash2Icon size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {runningItems.length === 0 && (
                  <div className="text-center py-8 text-cyber-muted">暂无进行中的任务</div>
                )}
                <div className="flex items-center justify-between mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-cyber-muted">每页</span>
                    <select
                      value={pageSize}
                      onChange={(e) => { const v = Number(e.target.value) || 10; setPageSize(v); setRunningPage(1); setCompletedPage(1); setPausedPage(1); }}
                      className="px-2 py-1 bg-cyber-bg border border-cyber-accent/30 rounded text-cyber-text"
                    >
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="cyber-button text-xs px-2 py-1" disabled={runningPage <= 1} onClick={() => setRunningPage(p => Math.max(1, p - 1))}>上一页</button>
                    <span className="text-cyber-muted">{runningPage} / {runningTotalPages}</span>
                    <button className="cyber-button text-xs px-2 py-1" disabled={runningPage >= runningTotalPages} onClick={() => setRunningPage(p => Math.min(runningTotalPages, p + 1))}>下一页</button>
                  </div>
                </div>
              </CardContent>
            </Card>
            )}

            {activeTab === 'completed' && (
            <Card className="cyber-card">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <span className="text-sm font-semibold text-cyber-text">已完成</span>
                  <span className="ml-2 text-xs text-cyber-muted">共 {completedTotal} 项</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {completedItems.map(item => (
                  <div 
                    key={item.id}
                    id={`queue-item-${item.id}`}
                    className={`relative bg-cyber-surface p-4 rounded-lg shadow-md border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-cyber-border`}
                  >
                    <div className="flex-grow">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{item.planCode}</span>
                        
                        {(() => {
                          const s = servers.find(ss => ss.planCode === item.planCode);
                          const name = s?.name;
                          if (!name) return null;
                          return (
                            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{name}</span>
                          );
                        })()}
                        {(() => {
                          const list = Array.isArray(item.datacenters) && item.datacenters.length > 0 ? item.datacenters : (item.datacenter ? [item.datacenter] : []);
                          if (list.length > 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list.map(dc => dc.toUpperCase()).join(' › ')}</span>
                            );
                          }
                          if (list.length === 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list[0].toUpperCase()}</span>
                            );
                          }
                          return null;
                        })()}
                        {Array.isArray(item.options) && item.options.length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">含 {item.options.length} 个可选配置</span>
                        )}
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center gap-1">
                          <ShoppingCart size={12} /> {Math.min(item.purchased || 0, item.quantity || 0)} / {item.quantity || 0}
                        </span>
                        {item.auto_pay && (
                          <span className="px-1.5 py-0.5 h-[18px] text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center justify-center gap-1 leading-none" title="自动支付">
                            <CreditCard size={12} className="text-cyber-text" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-cyber-muted">状态: 已完成 | 创建于: {new Date(item.createdAt || Date.now()).toLocaleString()}</p>
                      {Array.isArray(item.options) && item.options.length > 0 && (
                        <p className="text-xs text-cyber-muted mt-1">📦 可选配置: {item.options.join(', ')}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 sm:mt-0 flex-shrink-0">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 rounded-md">账户：{getAccountLabel(item.accountId)}</span>
                      {(() => {
                        const zone = getAccountZone(item.accountId);
                        if (!zone) return null;
                        return (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">
                            {zone}
                          </span>
                        );
                      })()}
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-blue-500/20 text-blue-400">已完成</span>
                      <button 
                        onClick={async () => { await api.put(`/queue/${item.id}/restart`); toast.success('已重新开始任务，并清空计数'); fetchQueueItems(true); }}
                        className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-green-400 transition-colors"
                        title="重新开始"
                      >
                        <PlayIcon size={16} />
                      </button>
                      <button onClick={() => beginEditQueueItem(item)} className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-cyber-primary transition-colors" title="编辑"><Settings size={16} /></button>
                      <button onClick={() => removeQueueItem(item.id)} className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-red-500 transition-colors" title="移除"><Trash2Icon size={16} /></button>
                    </div>
                  </div>
                ))}
                {completedItems.length === 0 && (
                  <div className="text-center py-8 text-cyber-muted">暂无已完成任务</div>
                )}
                <div className="flex items-center justify-between mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-cyber-muted">每页</span>
                    <select
                      value={pageSize}
                      onChange={(e) => { const v = Number(e.target.value) || 10; setPageSize(v); setCompletedPage(1); setRunningPage(1); setPausedPage(1); }}
                      className="px-2 py-1 bg-cyber-bg border border-cyber-accent/30 rounded text-cyber-text"
                    >
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="cyber-button text-xs px-2 py-1" disabled={completedPage <= 1} onClick={() => setCompletedPage(p => Math.max(1, p - 1))}>上一页</button>
                    <span className="text-cyber-muted">{completedPage} / {completedTotalPages}</span>
                    <button className="cyber-button text-xs px-2 py-1" disabled={completedPage >= completedTotalPages} onClick={() => setCompletedPage(p => Math.min(completedTotalPages, p + 1))}>下一页</button>
                  </div>
                </div>
              </CardContent>
            </Card>
            )}

            {activeTab === 'paused' && (
            <Card className="cyber-card">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <span className="text-sm font-semibold text-cyber-text">已暂停</span>
                  <span className="ml-2 text-xs text-cyber-muted">共 {pausedTotal} 项</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {pausedItems.map(item => (
                  <div 
                    key={item.id}
                    id={`queue-item-${item.id}`}
                    className={`relative bg-cyber-surface p-4 rounded-lg shadow-md border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-cyber-border`}
                  >
                    <div className="flex-grow">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{item.planCode}</span>
                        
                        {(() => {
                          const s = servers.find(ss => ss.planCode === item.planCode);
                          const name = s?.name;
                          if (!name) return null;
                          return (
                            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{name}</span>
                          );
                        })()}
                        {(() => {
                          const list = Array.isArray(item.datacenters) && item.datacenters.length > 0 ? item.datacenters : (item.datacenter ? [item.datacenter] : []);
                          if (list.length > 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list.map(dc => dc.toUpperCase()).join(' › ')}</span>
                            );
                          }
                          if (list.length === 1) {
                            return (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">{list[0].toUpperCase()}</span>
                            );
                          }
                          return null;
                        })()}
                        {Array.isArray(item.options) && item.options.length > 0 && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">含 {item.options.length} 个可选配置</span>
                        )}
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center gap-1">
                          <ShoppingCart size={12} /> {Math.min(item.purchased || 0, item.quantity || 0)} / {item.quantity || 0}
                        </span>
                        {item.auto_pay && (
                          <span className="px-1.5 py-0.5 h-[18px] text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 flex items-center justify-center gap-1 leading-none" title="自动支付">
                            <CreditCard size={12} className="text-cyber-text" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-cyber-muted">状态: 已暂停 | 创建于: {new Date(item.createdAt || Date.now()).toLocaleString()}</p>
                      {Array.isArray(item.options) && item.options.length > 0 && (
                        <p className="text-xs text-cyber-muted mt-1">📦 可选配置: {item.options.join(', ')}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 sm:mt-0 flex-shrink-0">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30 rounded-md">账户：{getAccountLabel(item.accountId)}</span>
                      {(() => {
                        const zone = getAccountZone(item.accountId);
                        if (!zone) return null;
                        return (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-md bg-cyber-grid/10 text-cyber-text border border-cyber-accent/30">
                            {zone}
                          </span>
                        );
                      })()}
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-yellow-500/20 text-yellow-400">已暂停</span>
                      <button 
                        onClick={() => toggleQueueItemStatus(item.id, item.status)}
                        className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-cyber-primary transition-colors"
                        title={item.status === 'running' ? "暂停" : "启动"}
                      >
                        {item.status === 'running' ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                      </button>
                      <button onClick={() => beginEditQueueItem(item)} className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-cyber-primary transition-colors" title="编辑"><Settings size={16} /></button>
                      <button onClick={() => removeQueueItem(item.id)} className="p-1.5 hover:bg-cyber-hover rounded text-cyber-secondary hover:text-red-500 transition-colors" title="移除"><Trash2Icon size={16} /></button>
                    </div>
                  </div>
                ))}
                {pausedItems.length === 0 && (
                  <div className="text-center py-8 text-cyber-muted">暂无已暂停任务</div>
                )}
                <div className="flex items-center justify-between mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-cyber-muted">每页</span>
                    <select
                      value={pageSize}
                      onChange={(e) => { const v = Number(e.target.value) || 10; setPageSize(v); setPausedPage(1); setRunningPage(1); setCompletedPage(1); }}
                      className="px-2 py-1 bg-cyber-bg border border-cyber-accent/30 rounded text-cyber-text"
                    >
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="cyber-button text-xs px-2 py-1" disabled={pausedPage <= 1} onClick={() => setPausedPage(p => Math.max(1, p - 1))}>上一页</button>
                    <span className="text-cyber-muted">{pausedPage} / {pausedTotalPages}</span>
                    <button className="cyber-button text-xs px-2 py-1" disabled={pausedPage >= pausedTotalPages} onClick={() => setPausedPage(p => Math.min(pausedTotalPages, p + 1))}>下一页</button>
                  </div>
                </div>
              </CardContent>
            </Card>
            )}
          </div>
        )}
      </div>
      
      {/* 确认清空对话框 */}
      {createPortal(
        <AnimatePresence>
          {showClearConfirm && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999]"
                onClick={() => setShowClearConfirm(false)}
              />
              <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-none">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="bg-cyber-dark border-2 border-cyber-accent/50 rounded-lg p-6 max-w-md w-full pointer-events-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-xl font-bold text-cyber-text mb-2">⚠️ 确认清空</h3>
                  <p className="text-cyber-muted mb-6 whitespace-pre-line">
                    {scopeAll ? '确定要清空全部账户的队列任务吗？' : '确定要清空当前账户的队列任务吗？'}{'\n'}
                    <span className="text-red-400 text-sm">此操作不可撤销。</span>
                  </p>
                  <div className="flex gap-3 justify-end">
                    <button
                      onClick={() => setShowClearConfirm(false)}
                      className="cyber-button px-4 py-2"
                    >
                      取消
                    </button>
                    <button
                      onClick={clearAllQueue}
                      className="cyber-button px-4 py-2 bg-red-900/30 border-red-700/40 text-red-300 hover:bg-red-800/40 hover:border-red-600/50 hover:text-red-200"
                    >
                      确认清空
                    </button>
                  </div>
                </motion.div>
              </div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};

export default QueuePage;
