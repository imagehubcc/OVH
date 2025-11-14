"""
服务器监控模块
定时检查服务器可用性变化并发送通知
"""

import threading
import time
from datetime import datetime, timedelta
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed


class ServerMonitor:
    """服务器监控类"""
    
    def __init__(self, check_availability_func, send_notification_func, add_log_func):
        """
        初始化监控器
        
        Args:
            check_availability_func: 检查服务器可用性的函数
            send_notification_func: 发送通知的函数
            add_log_func: 添加日志的函数
        """
        self.check_availability = check_availability_func
        self.send_notification = send_notification_func
        self.add_log = add_log_func
        
        self.subscriptions = []  # 订阅列表
        self.known_servers = set()  # 已知服务器集合
        self.running = False  # 运行状态
        self.check_interval = 5  # 检查间隔（秒），默认5秒
        self.thread = None
        
        # 价格缓存：key = f"{plan_code}|{sorted_options}"，value = {"price": str, "timestamp": float}
        self.price_cache = {}
        self.price_cache_ttl = 3 * 24 * 3600  # 缓存有效期：3天（秒）
        
        # 有效的plan_code集合：历史上有过价格查询成功的plan_code（永不过期）
        # 用于自动下单时跳过价格核验，加快下单速度
        self.valid_plan_codes = set()  # 存储有效的plan_code
        
        # Options 缓存：key = f"{plan_code}|{datacenter}"，value = {"options": list, "timestamp": float}
        # 用于在 Telegram callback_data 中 options 丢失时恢复（旧机制，保留兼容性）
        self.options_cache = {}
        self.options_cache_ttl = 24 * 3600  # 缓存有效期：24小时（秒）
        
        # UUID 消息缓存：key = UUID字符串，value = {"planCode": str, "datacenter": str, "options": list, "timestamp": float}
        # 用于通过UUID恢复完整的下单配置信息
        self.message_uuid_cache = {}
        self.message_uuid_cache_ttl = 24 * 3600  # 缓存有效期：24小时（秒）
        
        self.add_log("INFO", "服务器监控器初始化完成", "monitor")
    
    def _now_beijing(self) -> datetime:
        """返回北京时间（Asia/Shanghai）的当前时间。"""
        try:
            from zoneinfo import ZoneInfo  # Python 3.9+
            return datetime.now(ZoneInfo("Asia/Shanghai"))
        except Exception:
            # 兼容无zoneinfo环境：使用UTC+8近似
            return datetime.utcnow() + timedelta(hours=8)
    
    def add_subscription(self, plan_code, datacenters=None, notify_available=True, notify_unavailable=False, server_name=None, last_status=None, history=None, auto_order=False, auto_order_quantity=0):
        """
        添加服务器订阅
        
        Args:
            plan_code: 服务器型号代码
            datacenters: 要监控的数据中心列表，None或空列表表示监控所有
            notify_available: 是否在有货时提醒
            notify_unavailable: 是否在无货时提醒
            server_name: 服务器友好名称（如"KS-2 | Intel Xeon-D 1540"）
            last_status: 上次检查的状态字典（用于恢复，避免重复通知）
            history: 历史记录列表（用于恢复）
        """
        # 检查是否已存在
        existing = next((s for s in self.subscriptions if s["planCode"] == plan_code), None)
        if existing:
            self.add_log("WARNING", f"订阅已存在: {plan_code}，将更新配置（不会重置状态，避免重复通知）", "monitor")
            existing["datacenters"] = datacenters or []
            existing["notifyAvailable"] = notify_available
            existing["notifyUnavailable"] = notify_unavailable
            # 更新自动下单标记
            existing["autoOrder"] = bool(auto_order)
            # 更新自动下单数量
            existing["autoOrderQuantity"] = int(auto_order_quantity) if auto_order_quantity else 0
            # 更新服务器名称（总是更新，即使为None也要更新）
            existing["serverName"] = server_name
            # 确保历史记录字段存在
            if "history" not in existing:
                existing["history"] = []
            # ✅ 不重置 lastStatus，保留已知状态，避免重复通知
            return
        
        subscription = {
            "planCode": plan_code,
            "datacenters": datacenters or [],
            "notifyAvailable": notify_available,
            "notifyUnavailable": notify_unavailable,
            "lastStatus": last_status if last_status is not None else {},  # 恢复上次状态或初始化为空
            "createdAt": datetime.now().isoformat(),
            "history": history if history is not None else []  # 恢复历史记录或初始化为空
        }
        # 自动下单标记和数量
        if auto_order:
            subscription["autoOrder"] = True
        subscription["autoOrderQuantity"] = int(auto_order_quantity) if auto_order_quantity else 0
        
        # 添加服务器名称（如果提供）
        if server_name:
            subscription["serverName"] = server_name
        
        self.subscriptions.append(subscription)
        
        display_name = f"{plan_code} ({server_name})" if server_name else plan_code
        self.add_log("INFO", f"添加订阅: {display_name}, 数据中心: {datacenters or '全部'}", "monitor")
    
    def remove_subscription(self, plan_code):
        """删除订阅"""
        original_count = len(self.subscriptions)
        self.subscriptions = [s for s in self.subscriptions if s["planCode"] != plan_code]
        
        if len(self.subscriptions) < original_count:
            self.add_log("INFO", f"删除订阅: {plan_code}", "monitor")
            return True
        return False
    
    def clear_subscriptions(self):
        """清空所有订阅"""
        count = len(self.subscriptions)
        self.subscriptions = []
        self.add_log("INFO", f"清空所有订阅 ({count} 项)", "monitor")
        return count
    
    def check_availability_change(self, subscription):
        """
        检查单个订阅的可用性变化（配置级别监控）
        
        Args:
            subscription: 订阅配置
        """
        plan_code = subscription["planCode"]
        
        try:
            # 获取当前可用性（支持配置级别）
            current_availability = self.check_availability(plan_code)
            if not current_availability:
                self.add_log("WARNING", f"无法获取 {plan_code} 的可用性信息", "monitor")
                return
            
            last_status = subscription.get("lastStatus", {})
            monitored_dcs = subscription.get("datacenters", [])
            
            # 调试日志
            self.add_log("INFO", f"订阅 {plan_code} - 监控数据中心: {monitored_dcs if monitored_dcs else '全部'}", "monitor")
            self.add_log("INFO", f"订阅 {plan_code} - 当前发现 {len(current_availability)} 个配置组合", "monitor")
            
            # 收集所有需要查询价格的配置（用于并发执行）
            price_query_tasks = []
            config_results = {}  # 存储每个配置的处理结果
            
            # 遍历当前所有配置组合，收集任务
            for config_key, config_data in current_availability.items():
                # config_key 格式: "plancode.memory.storage" 或 "datacenter"
                # config_data 格式: {"datacenters": {"dc1": "status1", ...}, "memory": "xxx", "storage": "xxx"}
                
                # 如果是简单的数据中心状态（旧版兼容）
                if isinstance(config_data, str):
                    dc = config_key
                    status = config_data
                    
                    # 如果指定了数据中心列表，只监控列表中的
                    if monitored_dcs and dc not in monitored_dcs:
                        continue
                    
                    old_status = last_status.get(dc)
                    self._check_and_notify_change(subscription, plan_code, dc, status, old_status, None, dc)
                
                # 如果是配置级别的数据（新版配置监控）
                elif isinstance(config_data, dict) and "datacenters" in config_data:
                    memory = config_data.get("memory", "N/A")
                    storage = config_data.get("storage", "N/A")
                    config_display = f"{memory} + {storage}"
                    
                    self.add_log("INFO", f"检查配置: {config_display}", "monitor")
                    
                    # 准备配置信息
                    config_info = {
                        "memory": memory,
                        "storage": storage,
                        "display": config_display,
                        "options": config_data.get("options", [])  # 包含API2格式的选项代码
                    }
                    
                    # 先收集所有需要发送通知的数据中心
                    notifications_to_send = []
                    for dc, status in config_data["datacenters"].items():
                        # 如果指定了数据中心列表，只监控列表中的
                        if monitored_dcs and dc not in monitored_dcs:
                            continue
                        
                        # 使用配置作为key来追踪状态
                        status_key = f"{dc}|{config_key}"
                        old_status = last_status.get(status_key)
                        
                        # ✅ 添加调试日志，帮助定位问题
                        if old_status is None and status != "unavailable":
                            self.add_log("DEBUG", f"[状态检测] {status_key}: old_status=None, status={status}, 可能是首次检查或状态键不匹配", "monitor")
                        
                        # 检查是否需要发送通知（包括首次检查）
                        status_changed = False
                        change_type = None
                        
                        # ✅ 如果开启了自动下单，且 old_status 是 None，但 status 不是 unavailable
                        # 需要检查是否已经下过单（通过检查 lastStatus 中是否有相同配置的其他机房状态）
                        # 这样可以避免在持续有货的情况下，因为状态键不匹配而重复触发
                        # 但要注意：不能跳过同一检查循环中的其他机房，只跳过之前已经下过单的配置
                        if old_status is None and status != "unavailable" and subscription.get("autoOrder"):
                            # 检查是否有相同配置（config_key）的其他机房已经下过单
                            # 只检查相同配置的其他机房，避免跳过同一检查循环中的其他机房
                            has_same_config_status = any(
                                key != status_key and 
                                key.endswith(f"|{config_key}") and  # 相同配置的其他机房
                                value != "unavailable" 
                                for key, value in last_status.items()
                            )
                            if has_same_config_status:
                                # 不是真正的首次检查，可能是状态键不匹配
                                # 不触发状态变化，避免重复下单
                                self.add_log("WARNING", f"[状态检测] {status_key}: 检测到相同配置的其他机房已下过单（old_status=None但存在相同配置状态），跳过触发，避免重复下单", "monitor")
                                # 直接更新状态，不触发通知和下单
                                # 注意：状态会在检查循环末尾统一更新，这里不需要手动更新
                                continue
                        
                        # 首次检查时也发送通知（如果配置允许）
                        if old_status is None:
                            config_desc = f" [{config_display}]" if config_display else ""
                            if status == "unavailable":
                                self.add_log("INFO", f"首次检查: {plan_code}@{dc}{config_desc} 无货", "monitor")
                                # 首次检查无货时不通知（除非用户明确要求）
                                if subscription.get("notifyUnavailable", False):
                                    status_changed = True
                                    change_type = "unavailable"
                            else:
                                # 首次检查有货时发送通知
                                self.add_log("INFO", f"首次检查: {plan_code}@{dc}{config_desc} 有货（状态: {status}），发送通知", "monitor")
                                if subscription.get("notifyAvailable", True):
                                    status_changed = True
                                    change_type = "available"
                        # 从无货变有货
                        elif old_status == "unavailable" and status != "unavailable":
                            if subscription.get("notifyAvailable", True):
                                status_changed = True
                                change_type = "available"
                                config_desc = f" [{config_display}]" if config_display else ""
                                self.add_log("INFO", f"{plan_code}@{dc}{config_desc} 从无货变有货（状态: {status}）", "monitor")
                        # 从有货变无货
                        elif old_status not in ["unavailable", None] and status == "unavailable":
                            if subscription.get("notifyUnavailable", False):
                                status_changed = True
                                change_type = "unavailable"
                                config_desc = f" [{config_display}]" if config_display else ""
                                self.add_log("INFO", f"{plan_code}@{dc}{config_desc} 从有货变无货", "monitor")
                        
                        if status_changed:
                            notifications_to_send.append({
                                "dc": dc,
                                "status": status,
                                "old_status": old_status,
                                "status_key": status_key,
                                "change_type": change_type
                            })
                            # ✅ 添加调试日志，查看有多少个机房被添加到通知列表
                            if change_type == "available":
                                self.add_log("DEBUG", f"[状态检测] 添加有货通知: {plan_code}@{dc} (状态: {status}, old_status: {old_status})", "monitor")
                    
                    # 对于同一个配置，只查询一次价格（使用第一个有货的数据中心）
                    price_text = None
                    if notifications_to_send:
                        # 找出第一个有货的数据中心用于价格查询
                        first_available_dc = None
                        for notif in notifications_to_send:
                            if notif["change_type"] == "available" and notif["status"] != "unavailable":
                                first_available_dc = notif["dc"]
                                break
                        
                        # 如果有有货的数据中心，查询价格（优先使用缓存）
                        if first_available_dc:
                            # 先检查缓存，避免不必要的API调用
                            options = config_info.get("options", []) if config_info else []
                            cached_price = self._get_cached_price(plan_code, options)
                            if cached_price:
                                price_text = cached_price
                                self.add_log("DEBUG", f"配置 {config_display} 使用缓存价格: {price_text}", "monitor")
                            else:
                                # 缓存不存在，异步查询价格（使用线程池并发执行）
                                try:
                                    def fetch_price_task():
                                        """价格查询任务（用于并发执行）"""
                                        try:
                                            price_result = self._get_price_info(plan_code, first_available_dc, config_info)
                                            return price_result
                                        except Exception as e:
                                            self.add_log("WARNING", f"配置 {config_display} 价格获取异常: {str(e)}", "monitor")
                                            return None
                                    
                                    # 收集到任务列表，稍后并发查询
                                    price_query_tasks.append({
                                        "config_key": config_key,
                                        "config_info": config_info,
                                        "config_display": config_display,
                                        "plan_code": plan_code,
                                        "first_available_dc": first_available_dc,
                                        "notifications_to_send": notifications_to_send,
                                        "fetch_func": fetch_price_task
                                    })
                                    # 先存储配置结果，价格稍后填充
                                    config_results[config_key] = {
                                        "config_info": config_info,
                                        "notifications_to_send": notifications_to_send,
                                        "price_text": None  # 稍后填充
                                    }
                                except Exception as e:
                                    self.add_log("WARNING", f"价格获取过程异常: {str(e)}", "monitor")
                                    config_results[config_key] = {
                                        "config_info": config_info,
                                        "notifications_to_send": notifications_to_send,
                                        "price_text": None
                                    }
                        else:
                            # 没有有货的数据中心，不需要查询价格
                            config_results[config_key] = {
                                "config_info": config_info,
                                "notifications_to_send": notifications_to_send,
                                "price_text": None
                            }
                    else:
                        # 没有通知需要发送，不需要查询价格
                        config_results[config_key] = {
                            "config_info": config_info,
                            "notifications_to_send": notifications_to_send,
                            "price_text": None
                        }
            
            # 并发查询所有需要查询价格的配置
            if price_query_tasks:
                self.add_log("INFO", f"并发查询 {len(price_query_tasks)} 个配置的价格", "monitor")
                with ThreadPoolExecutor(max_workers=min(len(price_query_tasks), 10)) as executor:
                    # 提交所有价格查询任务
                    future_to_task = {executor.submit(task["fetch_func"]): task for task in price_query_tasks}
                    # 等待所有任务完成并收集结果
                    for future in as_completed(future_to_task):
                        task = future_to_task[future]
                        config_key = task["config_key"]
                        config_display = task["config_display"]
                        try:
                            price_text = future.result(timeout=15.0)
                            if price_text:
                                config_results[config_key]["price_text"] = price_text
                                self.add_log("DEBUG", f"配置 {config_display} 价格获取成功: {price_text}", "monitor")
                            else:
                                self.add_log("WARNING", f"配置 {config_display} 价格获取失败，通知中不包含价格信息", "monitor")
                        except Exception as e:
                            self.add_log("WARNING", f"配置 {config_display} 价格查询任务异常: {str(e)}", "monitor")
            
            # 处理所有配置的结果（发送通知、下单等）
            for config_key, result in config_results.items():
                config_info = result["config_info"]
                notifications_to_send = result["notifications_to_send"]
                price_text = result["price_text"]
                config_display = config_info.get("display", "") if config_info else ""
                
                # 按change_type分组发送通知（汇总同一配置的所有有货机房）
                available_notifications = [n for n in notifications_to_send if n["change_type"] == "available"]
                unavailable_notifications = [n for n in notifications_to_send if n["change_type"] == "unavailable"]
                
                # ✅ 添加调试日志，查看有多少个机房有货
                if available_notifications:
                    self.add_log("INFO", f"[monitor->order] 检测到 {len(available_notifications)} 个机房有货: {[n['dc'] for n in available_notifications]}", "monitor")
                
                # 自动下单仅在配置了 autoOrder 时执行
                if available_notifications and subscription.get("autoOrder"):
                    try:
                        import requests
                        from api_key_config import API_SECRET_KEY
                        
                        # 检查plan_code是否为有效（历史上有过价格查询成功）
                        is_valid_plan_code = plan_code in self.valid_plan_codes
                        
                        # 如果plan_code无效，先查询一次价格（只查询一次，不管有多少个机房）
                        # 同配置不同机房价格相同，查询一次即可
                        if not is_valid_plan_code:
                            # 找出第一个有货的数据中心用于价格查询
                            first_available_dc = None
                            for notif in available_notifications:
                                if notif["change_type"] == "available" and notif["status"] != "unavailable":
                                    first_available_dc = notif["dc"]
                                    break
                            
                            if first_available_dc:
                                # 使用配置级 options（若存在），否则留空让后端自动匹配
                                order_options = (config_info.get("options") if config_info else []) or []
                                
                                # 先查询一次价格，验证plan_code是否有效（使用第一个机房，只查询一次）
                                self.add_log("INFO", f"[monitor->order] plan_code未标记为有效，先查询一次价格验证（同配置只查一次）: {plan_code}@{first_available_dc}, options={order_options}", "monitor")
                                
                                try:
                                    # 调用内部价格查询API，只验证价格，不实际下单
                                    price_api_url = "http://127.0.0.1:19998/api/internal/monitor/price"
                                    price_payload = {
                                        "plan_code": plan_code,
                                        "datacenter": first_available_dc,
                                        "options": order_options
                                    }
                                    
                                    price_resp = requests.post(price_api_url, json=price_payload, timeout=15)
                                    
                                    # 如果价格查询成功，标记plan_code为有效
                                    if price_resp.status_code == 200:
                                        price_result = price_resp.json()
                                        if price_result.get("success") and price_result.get("price"):
                                            self.valid_plan_codes.add(plan_code)
                                            is_valid_plan_code = True
                                            self.add_log("INFO", f"[monitor->order] 价格验证成功，标记plan_code为有效: {plan_code}，后续所有机房将跳过价格核验", "monitor")
                                        else:
                                            self.add_log("WARNING", f"[monitor->order] 价格验证失败: {price_result.get('error', '未知错误')}", "monitor")
                                    else:
                                        self.add_log("WARNING", f"[monitor->order] 价格验证请求失败({price_resp.status_code}): {price_resp.text}", "monitor")
                                except requests.exceptions.RequestException as e:
                                    self.add_log("WARNING", f"[monitor->order] 价格验证请求异常: {str(e)}", "monitor")
                        
                        # 获取自动下单数量（如果设置了数量，则批量下单，不受2分钟限制）
                        auto_order_quantity = subscription.get("autoOrderQuantity", 0)
                        self.add_log("INFO", f"[monitor->order] 读取自动下单数量: autoOrderQuantity={auto_order_quantity}, subscription keys={list(subscription.keys())}", "monitor")
                        skip_duplicate_check = auto_order_quantity > 0  # 如果设置了数量，跳过2分钟限制
                        order_count = auto_order_quantity if auto_order_quantity > 0 else 1  # 下单数量
                        self.add_log("INFO", f"[monitor->order] 下单配置: order_count={order_count}, skip_duplicate_check={skip_duplicate_check}", "monitor")
                        
                        # 对所有有货的机房进行并发下单（如果plan_code已标记为有效，都跳过价格核验）
                        def place_order(notif, order_index=0):
                            """下单函数（用于并发执行）"""
                            dc_to_order = notif["dc"]
                            # 使用配置级 options（若存在），否则留空让后端自动匹配
                            order_options = (config_info.get("options") if config_info else []) or []
                            payload = {
                                "planCode": plan_code,
                                "datacenter": dc_to_order,
                                "options": order_options,
                                "skipPriceCheck": is_valid_plan_code,  # 如果plan_code有效，跳过价格核验
                                "skipDuplicateCheck": skip_duplicate_check  # 如果设置了数量，跳过2分钟限制
                            }
                            headers = {"X-API-Key": API_SECRET_KEY}
                            api_url = "http://127.0.0.1:19998/api/config-sniper/quick-order"
                            
                            if is_valid_plan_code:
                                self.add_log("INFO", f"[monitor->order] 尝试快速下单（跳过价格核验）: {plan_code}@{dc_to_order}, options={order_options}, 数量={order_count}, 跳过限制={skip_duplicate_check}", "monitor")
                            else:
                                self.add_log("INFO", f"[monitor->order] 尝试快速下单: {plan_code}@{dc_to_order}, options={order_options}, 数量={order_count}, 跳过限制={skip_duplicate_check}", "monitor")
                            
                            try:
                                resp = requests.post(api_url, json=payload, headers=headers, timeout=30)
                                if resp.status_code == 200:
                                    self.add_log("INFO", f"[monitor->order] 快速下单成功: {plan_code}@{dc_to_order} (第{order_index + 1}/{order_count}单)", "monitor")
                                    return True
                                else:
                                    self.add_log("WARNING", f"[monitor->order] 快速下单失败({resp.status_code}): {resp.text}", "monitor")
                                    return False
                            except requests.exceptions.RequestException as e:
                                self.add_log("WARNING", f"[monitor->order] 快速下单请求异常: {str(e)}", "monitor")
                                return False
                        
                        # 使用线程池并发执行所有下单请求
                        # 如果设置了数量，需要为每个机房下单多次
                        total_orders = len(available_notifications) * order_count
                        self.add_log("INFO", f"[monitor->order] 并发执行 {total_orders} 个下单请求（{len(available_notifications)}个机房 × {order_count}单/机房）", "monitor")
                        with ThreadPoolExecutor(max_workers=min(total_orders, 10)) as executor:
                            # 提交所有下单任务（如果设置了数量，每个机房下单多次）
                            future_to_notif = {}
                            for notif in available_notifications:
                                for i in range(order_count):
                                    future = executor.submit(place_order, notif, i)
                                    future_to_notif[future] = (notif, i)
                            # ✅ 自动下单后，立即更新状态，避免下次检查时重复触发
                            # 在提交下单任务后立即更新状态，不管下单是否成功
                            # 这样下次检查时 old_status 和 status 相同，不会触发状态变化，避免重复下单
                            for notif in available_notifications:
                                status_key = notif.get("status_key")
                                if status_key:
                                    # 立即更新状态，避免下次检查时重复触发
                                    # 使用当前状态作为新状态，这样下次检查时 old_status 和 status 相同，不会触发状态变化
                                    current_status = notif.get("status")
                                    if current_status and current_status != "unavailable":
                                        subscription["lastStatus"][status_key] = current_status
                                        self.add_log("INFO", f"[monitor->order] 自动下单后立即更新状态: {status_key} = {current_status}，避免重复触发", "monitor")
                            
                            # 等待所有任务完成（不阻塞，但会等待结果）
                            for future in as_completed(future_to_notif):
                                notif, order_index = future_to_notif[future]
                                try:
                                    _ = future.result()
                                except Exception as e:
                                    self.add_log("WARNING", f"[monitor->order] 下单任务异常: {plan_code}@{notif['dc']}, {str(e)}", "monitor")
                    except Exception as e:
                        self.add_log("WARNING", f"[monitor->order] 下单前置流程异常: {str(e)}", "monitor")

                # 发送有货通知（无论是否开启自动下单）
                if available_notifications:
                    config_desc = f" [{config_info['display']}]" if config_info else ""
                    self.add_log("INFO", f"准备发送汇总提醒: {plan_code}{config_desc} - {len(available_notifications)}个机房有货", "monitor")
                    server_name = subscription.get("serverName")
                    
                    # 创建包含价格的配置信息副本
                    # 如果价格查询超时或失败，再次尝试从缓存获取（可能在查询过程中已缓存）
                    if not price_text and config_info:
                        options = config_info.get("options", [])
                        cached_price = self._get_cached_price(plan_code, options)
                        if cached_price:
                            price_text = cached_price
                            self.add_log("DEBUG", f"价格查询超时后从缓存获取: {price_text}", "monitor")
                    
                    config_info_with_price = config_info.copy() if config_info else None
                    if config_info_with_price:
                        config_info_with_price["cached_price"] = price_text  # 传递缓存的价格
                    
                    # 汇总所有有货的机房数据
                    available_dcs = [{"dc": n["dc"], "status": n["status"]} for n in available_notifications]
                    self.send_availability_alert_grouped(
                        plan_code, available_dcs, config_info_with_price, server_name
                    )
                    
                    # 添加到历史记录
                    if "history" not in subscription:
                        subscription["history"] = []
                    
                    for notif in available_notifications:
                        history_entry = {
                            "timestamp": self._now_beijing().isoformat(),
                            "datacenter": notif["dc"],
                            "status": notif["status"],
                            "changeType": notif["change_type"],
                            "oldStatus": notif["old_status"]
                        }
                        
                        if config_info:
                            history_entry["config"] = config_info
                        
                        subscription["history"].append(history_entry)
                    
                # 发送无货通知（每个机房单独发送）
                for notif in unavailable_notifications:
                    config_desc = f" [{config_info['display']}]" if config_info else ""
                    self.add_log("INFO", f"准备发送提醒: {plan_code}@{notif['dc']}{config_desc} - {notif['change_type']}", "monitor")
                    server_name = subscription.get("serverName")
                    
                    # 计算从有货到无货的持续时长（仅在确实是从有货变无货时计算）
                    duration_text = None
                    # 只有当前状态是无货，且旧状态不是无货或None时，才是"从有货变无货"
                    is_became_unavailable = (notif["change_type"] == "unavailable" and 
                                              notif.get("old_status") not in ["unavailable", None])
                    if is_became_unavailable:
                        try:
                            last_available_ts = None
                            same_config_display = config_info.get("display") if config_info else None
                            history_list = subscription.get("history", [])
                            self.add_log("INFO", f"[历时计算] {plan_code}@{notif['dc']} 从有货变无货，old_status={notif.get('old_status')}, 历史记录数: {len(history_list)}, 配置: {same_config_display}", "monitor")
                            # 如果历史记录为空，尝试从同一轮检查的有货通知中获取时间戳
                            # 注意：有货通知的历史记录已经在上面添加到 subscription["history"] 中
                            # 从后向前查找最近一次相同机房（且相同配置显示文本时更精确）的 available 记录
                            for entry in reversed(history_list):
                                if entry.get("datacenter") != notif["dc"]:
                                    continue
                                if entry.get("changeType") != "available":
                                    continue
                                if same_config_display:
                                    cfg = entry.get("config", {})
                                    if cfg and cfg.get("display") != same_config_display:
                                        continue
                                last_available_ts = entry.get("timestamp")
                                if last_available_ts:
                                    self.add_log("INFO", f"[历时计算] 找到有货记录: {plan_code}@{notif['dc']}, 时间: {last_available_ts}", "monitor")
                                    break
                            if last_available_ts:
                                try:
                                    # 解析ISO时间，按北京时间计算时长（兼容无时区与带时区）
                                    from datetime import datetime as _dt
                                    try:
                                        # 优先解析为带时区
                                        start_dt = _dt.fromisoformat(last_available_ts.replace("Z", "+00:00"))
                                    except Exception:
                                        start_dt = _dt.fromisoformat(last_available_ts)
                                    # 若解析为naive时间，视为北京时间
                                    if start_dt.tzinfo is None:
                                        try:
                                            from zoneinfo import ZoneInfo
                                            start_dt = start_dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
                                        except Exception:
                                            # 退化：将其视为UTC+8
                                            start_dt = start_dt
                                    delta = self._now_beijing() - start_dt
                                    total_sec = int(delta.total_seconds())
                                    if total_sec < 0:
                                        total_sec = 0
                                    days = total_sec // 86400
                                    rem = total_sec % 86400
                                    hours = rem // 3600
                                    minutes = (rem % 3600) // 60
                                    seconds = rem % 60
                                    if days > 0:
                                        duration_text = f"历时 {days}天{hours}小时{minutes}分{seconds}秒"
                                    elif hours > 0:
                                        duration_text = f"历时 {hours}小时{minutes}分{seconds}秒"
                                    elif minutes > 0:
                                        duration_text = f"历时 {minutes}分{seconds}秒"
                                    else:
                                        duration_text = f"历时 {seconds}秒"
                                    self.add_log("INFO", f"[历时计算] 计算成功: {plan_code}@{notif['dc']}, {duration_text}", "monitor")
                                except Exception as e:
                                    self.add_log("WARNING", f"[历时计算] 计算异常: {plan_code}@{notif['dc']}, 错误: {str(e)}", "monitor")
                                    duration_text = None
                            else:
                                self.add_log("INFO", f"[历时计算] 未找到有货记录: {plan_code}@{notif['dc']}, 无法计算历时", "monitor")
                        except Exception as e:
                            self.add_log("WARNING", f"[历时计算] 查找异常: {plan_code}@{notif['dc']}, 错误: {str(e)}", "monitor")
                            duration_text = None
                    else:
                        # 首次检查或无货通知，不计算历时
                        pass
                    
                    self.send_availability_alert(plan_code, notif["dc"], notif["status"], notif["change_type"], 
                                                config_info, server_name, duration_text=duration_text)
                    
                    # 添加到历史记录
                    if "history" not in subscription:
                        subscription["history"] = []
                    
                    history_entry = {
                        "timestamp": self._now_beijing().isoformat(),
                        "datacenter": notif["dc"],
                        "status": notif["status"],
                        "changeType": notif["change_type"],
                        "oldStatus": notif["old_status"]
                    }
                    
                    if config_info:
                        history_entry["config"] = config_info
                    
                    subscription["history"].append(history_entry)
                
                # 限制历史记录数量
                if len(subscription["history"]) > 100:
                    subscription["history"] = subscription["history"][-100:]
            
            # 更新状态（需要转换为状态字典）
            # ✅ 使用合并而不是替换，保留自动下单后立即更新的状态
            # 这样可以避免状态键不匹配导致重复触发的问题
            new_last_status = subscription.get("lastStatus", {}).copy()  # 先复制现有状态
            for config_key, config_data in current_availability.items():
                if isinstance(config_data, str):
                    # 简单的数据中心状态
                    new_last_status[config_key] = config_data
                elif isinstance(config_data, dict) and "datacenters" in config_data:
                    # 配置级别的状态
                    for dc, status in config_data["datacenters"].items():
                        status_key = f"{dc}|{config_key}"
                        old_status_value = new_last_status.get(status_key)
                        new_last_status[status_key] = status
                        # 添加调试日志，帮助定位问题
                        if old_status_value != status:
                            self.add_log("DEBUG", f"[状态更新] {status_key}: {old_status_value} -> {status}", "monitor")
            
            subscription["lastStatus"] = new_last_status
            
        except Exception as e:
            self.add_log("ERROR", f"检查 {plan_code} 可用性时出错: {str(e)}", "monitor")
            self.add_log("ERROR", f"错误详情: {traceback.format_exc()}", "monitor")
    
    def _check_and_notify_change(self, subscription, plan_code, dc, status, old_status, config_info=None, status_key=None):
        """
        检查状态变化并发送通知
        
        Args:
            subscription: 订阅对象
            plan_code: 服务器型号
            dc: 数据中心
            status: 当前状态
            old_status: 旧状态
            config_info: 配置信息 {"memory": "xxx", "storage": "xxx", "display": "xxx"}
            status_key: 状态键（用于lastStatus）
        """
        # 状态变化检测（包括首次检查）
        status_changed = False
        change_type = None
        
        # 首次检查时也发送通知（如果配置允许）
        if old_status is None:
            config_desc = f" [{config_info['display']}]" if config_info else ""
            if status == "unavailable":
                self.add_log("INFO", f"首次检查: {plan_code}@{dc}{config_desc} 无货", "monitor")
                # 首次检查无货时不通知（除非用户明确要求）
                if subscription.get("notifyUnavailable", False):
                    status_changed = True
                    change_type = "unavailable"
            else:
                # 首次检查有货时发送通知
                self.add_log("INFO", f"首次检查: {plan_code}@{dc}{config_desc} 有货（状态: {status}），发送通知", "monitor")
            if subscription.get("notifyAvailable", True):
                status_changed = True
                change_type = "available"
        # 从无货变有货
        elif old_status == "unavailable" and status != "unavailable":
            if subscription.get("notifyAvailable", True):
                status_changed = True
                change_type = "available"
                config_desc = f" [{config_info['display']}]" if config_info else ""
                self.add_log("INFO", f"{plan_code}@{dc}{config_desc} 从无货变有货", "monitor")
        
        # 从有货变无货
        elif old_status not in ["unavailable", None] and status == "unavailable":
            if subscription.get("notifyUnavailable", False):
                status_changed = True
                change_type = "unavailable"
                config_desc = f" [{config_info['display']}]" if config_info else ""
                self.add_log("INFO", f"{plan_code}@{dc}{config_desc} 从有货变无货", "monitor")
        
        # 发送通知并记录历史
        if status_changed:
            config_desc = f" [{config_info['display']}]" if config_info else ""
            self.add_log("INFO", f"准备发送提醒: {plan_code}@{dc}{config_desc} - {change_type}", "monitor")
            # 获取服务器名称
            server_name = subscription.get("serverName")

            # 如果是“有货 -> 无货”，计算本次有货持续时长
            duration_text = None
            if change_type == "unavailable":
                try:
                    last_available_ts = None
                    same_config_display = config_info.get("display") if config_info else None
                    # 从后向前查找最近一次相同机房（且相同配置显示文本时更精确）的 available 记录
                    for entry in reversed(subscription.get("history", [])):
                        if entry.get("datacenter") != dc:
                            continue
                        if entry.get("changeType") != "available":
                            continue
                        if same_config_display:
                            cfg = entry.get("config", {})
                            if cfg.get("display") != same_config_display:
                                continue
                        last_available_ts = entry.get("timestamp")
                        if last_available_ts:
                            break
                    if last_available_ts:
                        try:
                            # 解析ISO时间，按北京时间计算时长（兼容无时区与带时区）
                            from datetime import datetime as _dt
                            try:
                                # 优先解析为带时区
                                start_dt = _dt.fromisoformat(last_available_ts.replace("Z", "+00:00"))
                            except Exception:
                                start_dt = _dt.fromisoformat(last_available_ts)
                            # 若解析为naive时间，视为北京时间
                            if start_dt.tzinfo is None:
                                try:
                                    from zoneinfo import ZoneInfo
                                    start_dt = start_dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
                                except Exception:
                                    # 退化：将其视为UTC+8
                                    start_dt = start_dt
                            delta = self._now_beijing() - start_dt
                            total_sec = int(delta.total_seconds())
                            if total_sec < 0:
                                total_sec = 0
                            days = total_sec // 86400
                            rem = total_sec % 86400
                            hours = rem // 3600
                            minutes = (rem % 3600) // 60
                            seconds = rem % 60
                            if days > 0:
                                duration_text = f"历时 {days}天{hours}小时{minutes}分{seconds}秒"
                            elif hours > 0:
                                duration_text = f"历时 {hours}小时{minutes}分{seconds}秒"
                            elif minutes > 0:
                                duration_text = f"历时 {minutes}分{seconds}秒"
                            else:
                                duration_text = f"历时 {seconds}秒"
                        except Exception:
                            duration_text = None
                except Exception:
                    duration_text = None

            self.send_availability_alert(plan_code, dc, status, change_type, config_info, server_name, duration_text=duration_text)
            
            # 添加到历史记录
            if "history" not in subscription:
                subscription["history"] = []
            
            history_entry = {
                "timestamp": self._now_beijing().isoformat(),
                "datacenter": dc,
                "status": status,
                "changeType": change_type,
                "oldStatus": old_status
            }
            
            # 添加配置信息到历史记录
            if config_info:
                history_entry["config"] = config_info
            
            subscription["history"].append(history_entry)
            
            # 限制历史记录数量，保留最近100条
            if len(subscription["history"]) > 100:
                subscription["history"] = subscription["history"][-100:]
    
    def send_availability_alert_grouped(self, plan_code, available_dcs, config_info=None, server_name=None):
        """
        发送汇总的可用性提醒（一个通知包含多个有货的机房，带内联键盘按钮）
        
        Args:
            plan_code: 服务器型号
            available_dcs: 有货的数据中心列表 [{"dc": "gra", "status": "available"}, ...]
            config_info: 配置信息 {"memory": "xxx", "storage": "xxx", "display": "xxx", "options": [...]}
            server_name: 服务器友好名称
        """
        try:
            import json
            import base64
            
            message = f"🎉 服务器上架通知！\n\n"
            
            if server_name:
                message += f"服务器: {server_name}\n"
            
            message += f"型号: {plan_code}\n"
            
            if config_info:
                message += (
                    f"配置: {config_info['display']}\n"
                    f"├─ 内存: {config_info['memory']}\n"
                    f"└─ 存储: {config_info['storage']}\n"
                )
            
            # 添加价格信息
            price_text = None
            if config_info and "cached_price" in config_info:
                price_text = config_info.get("cached_price")
            
            # 如果没有传递的价格，尝试从缓存中获取
            if not price_text and config_info:
                options = config_info.get("options", [])
                cached_price = self._get_cached_price(plan_code, options)
                if cached_price:
                    price_text = cached_price
                    self.add_log("DEBUG", f"汇总通知使用缓存价格: {price_text}", "monitor")
            
            if price_text:
                message += f"\n💰 价格: {price_text}\n"
            
            message += f"\n✅ 有货的机房 ({len(available_dcs)}个):\n"
            for dc_info in available_dcs:
                dc = dc_info.get("dc", "")
                status = dc_info.get("status", "")
                # 数据中心名称映射
                dc_display_map = {
                    "gra": "🇫🇷 法国·格拉沃利讷",
                    "rbx": "🇫🇷 法国·鲁贝",
                    "sbg": "🇫🇷 法国·斯特拉斯堡",
                    "bhs": "🇨🇦 加拿大·博舍维尔",
                    "syd": "🇦🇺 澳大利亚·悉尼",
                    "sgp": "🇸🇬 新加坡",
                    "ynm": "🇮🇳 印度·孟买",
                    "waw": "🇵🇱 波兰·华沙",
                    "fra": "🇩🇪 德国·法兰克福",
                    "lon": "🇬🇧 英国·伦敦",
                    "par": "🇫🇷 法国·巴黎",
                    "eri": "🇮🇹 意大利·埃里切",
                    "lim": "🇵🇱 波兰·利马诺瓦",
                    "vin": "🇺🇸 美国·弗吉尼亚",
                    "hil": "🇺🇸 美国·俄勒冈"
                }
                dc_display = dc_display_map.get(dc.lower(), dc.upper())
                message += f"  • {dc_display} ({dc.upper()})\n"
            
            message += f"\n⏰ 时间: {self._now_beijing().strftime('%Y-%m-%d %H:%M:%S')}"
            message += f"\n\n💡 点击下方按钮可直接下单对应机房！"
            
            # 构建内联键盘按钮（每个机房一个按钮，最多每行2个按钮）
            inline_keyboard = []
            row = []
            for idx, dc_info in enumerate(available_dcs):
                dc = dc_info.get("dc", "")
                dc_display_map = {
                    "gra": "🇫🇷 Gra",
                    "rbx": "🇫🇷 Rbx",
                    "sbg": "🇫🇷 Sbg",
                    "bhs": "🇨🇦 Bhs",
                    "syd": "🇦🇺 Syd",
                    "sgp": "🇸🇬 Sgp",
                    "ynm": "🇮🇳 Mum",
                    "waw": "🇵🇱 Waw",
                    "fra": "🇩🇪 Fra",
                    "lon": "🇬🇧 Lon",
                    "par": "🇫🇷 Par",
                    "eri": "🇮🇹 Eri",
                    "lim": "🇵🇱 Lim",
                    "vin": "🇺🇸 Vin",
                    "hil": "🇺🇸 Hil"
                }
                # 生成按钮文本，包含机房信息和"一键下单"提示
                dc_display_short = dc_display_map.get(dc.lower(), dc.upper())
                button_text = f"{dc_display_short} 一键下单"
                
                # 提取配置信息
                options = config_info.get("options", []) if config_info else []
                
                # 为每个按钮生成UUID并存储完整配置信息（UUID机制）
                message_uuid = str(uuid.uuid4())
                self.message_uuid_cache[message_uuid] = {
                    "planCode": plan_code,
                    "datacenter": dc,
                    "options": options,
                    "configInfo": config_info,  # 保存完整的config_info以便将来扩展
                    "timestamp": time.time()
                }
                self.add_log("DEBUG", f"生成消息UUID: {message_uuid}, 配置: {plan_code}@{dc}, options={options}", "monitor")
                
                # callback_data 只包含UUID（使用短格式：u=uuid）
                # 格式：{"a":"add_to_queue","u":"uuid"}，JSON后约45-50字节，远小于64字节限制
                callback_data = {
                    "a": "add_to_queue",
                    "u": message_uuid  # u = uuid
                }
                callback_data_str = json.dumps(callback_data, ensure_ascii=False, separators=(',', ':'))
                
                # UUID机制下，callback_data通常只有40-50字节，远小于64字节限制
                if len(callback_data_str) > 64:
                    self.add_log("WARNING", f"UUID callback_data异常长: {len(callback_data_str)}字节, UUID={message_uuid}", "monitor")
                
                callback_data_final = callback_data_str[:64]  # 安全限制，但通常不会截断
                
                row.append({
                    "text": button_text,
                    "callback_data": callback_data_final
                })
                
                # 每行最多2个按钮
                if len(row) >= 2 or idx == len(available_dcs) - 1:
                    inline_keyboard.append(row)
                    row = []
            
            reply_markup = {"inline_keyboard": inline_keyboard}
            
            config_desc = f" [{config_info['display']}]" if config_info else ""
            self.add_log("INFO", f"正在发送汇总Telegram通知: {plan_code}{config_desc} - {len(available_dcs)}个机房", "monitor")
            
            # 调用发送函数，传入reply_markup
            # 检查send_notification是否支持reply_markup参数
            import inspect
            sig = inspect.signature(self.send_notification)
            if 'reply_markup' in sig.parameters:
                result = self.send_notification(message, reply_markup=reply_markup)
            else:
                # 如果不支持，先尝试用**kwargs方式调用
                try:
                    result = self.send_notification(message, **{"reply_markup": reply_markup})
                except:
                    # 如果还是不支持，先记录警告然后只发送消息
                    self.add_log("WARNING", "send_notification函数不支持reply_markup参数，仅发送文字消息", "monitor")
                    result = self.send_notification(message)
            
            if result:
                self.add_log("INFO", f"✅ Telegram汇总通知发送成功: {plan_code}{config_desc}", "monitor")
            else:
                self.add_log("WARNING", f"⚠️ Telegram汇总通知发送失败: {plan_code}{config_desc}", "monitor")
                
        except Exception as e:
            self.add_log("ERROR", f"发送汇总提醒时发生异常: {str(e)}", "monitor")
            import traceback
            self.add_log("ERROR", f"错误详情: {traceback.format_exc()}", "monitor")
    
    def send_availability_alert(self, plan_code, datacenter, status, change_type, config_info=None, server_name=None, duration_text=None):
        """
        发送可用性变化提醒
        
        Args:
            plan_code: 服务器型号
            datacenter: 数据中心
            status: 状态
            change_type: 变化类型
            config_info: 配置信息 {"memory": "xxx", "storage": "xxx", "display": "xxx"}
            server_name: 服务器友好名称（如"KS-2 | Intel Xeon-D 1540"）
        """
        try:
            if change_type == "available":
                # 基础消息
                message = f"🎉 服务器上架通知！\n\n"
                
                # 添加服务器名称（如果有）
                if server_name:
                    message += f"服务器: {server_name}\n"
                
                message += f"型号: {plan_code}\n"
                message += f"数据中心: {datacenter}\n"
                
                # 添加配置信息（如果有）
                if config_info:
                    message += (
                        f"配置: {config_info['display']}\n"
                        f"├─ 内存: {config_info['memory']}\n"
                        f"└─ 存储: {config_info['storage']}\n"
                    )
                
                # 获取价格信息（优先使用缓存的价格）
                price_text = None
                
                # 如果config_info中包含缓存的价格，直接使用
                if config_info and "cached_price" in config_info:
                    price_text = config_info.get("cached_price")
                    if price_text:
                        self.add_log("DEBUG", f"使用传递的缓存价格: {price_text}", "monitor")
                
                # 如果没有传递的价格，先检查内存缓存
                if not price_text and config_info:
                    options = config_info.get("options", [])
                    cached_price = self._get_cached_price(plan_code, options)
                    if cached_price:
                        price_text = cached_price
                        self.add_log("DEBUG", f"使用内存缓存价格: {price_text}", "monitor")
                
                # 如果还是没有缓存的价格，才去查询（异步，不阻塞通知发送）
                if not price_text:
                    try:
                        import threading
                        import queue
                        price_queue = queue.Queue()
                        
                        def fetch_price():
                            try:
                                price_result = self._get_price_info(plan_code, datacenter, config_info)
                                price_queue.put(price_result)
                            except Exception as e:
                                self.add_log("WARNING", f"价格获取线程异常: {str(e)}", "monitor")
                                price_queue.put(None)
                        
                        # 启动价格获取线程（异步，不阻塞通知发送）
                        price_thread = threading.Thread(target=fetch_price, daemon=True)
                        price_thread.start()
                        # 超时时间15秒，给价格查询更多时间
                        price_thread.join(timeout=15.0)  # 最多等待15秒
                        
                        if price_thread.is_alive():
                            # 如果线程还在运行，说明超时了，直接发送通知（不等待价格）
                            self.add_log("WARNING", f"价格获取超时（15秒），发送不带价格的通知", "monitor")
                            price_text = None
                        else:
                            # 尝试获取结果（如果线程完成）
                            try:
                                price_text = price_queue.get_nowait()
                            except queue.Empty:
                                price_text = None
                        
                        if not price_text:
                            # 如果价格获取失败，记录警告但继续发送通知
                            self.add_log("WARNING", f"价格获取失败或超时，通知中不包含价格信息", "monitor")
                    except Exception as e:
                        self.add_log("WARNING", f"价格获取过程异常: {str(e)}，发送不带价格的通知", "monitor")
                        import traceback
                        self.add_log("WARNING", f"价格获取异常详情: {traceback.format_exc()}", "monitor")
                
                # 如果有价格信息，添加到消息中
                if price_text:
                    message += f"\n💰 价格: {price_text}\n"
                
                message += (
                    f"状态: {status}\n"
                    f"时间: {self._now_beijing().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                    f"💡 快去抢购吧！"
                )
            else:
                # 基础消息
                message = f"📦 服务器下架通知\n\n"
                
                # 添加服务器名称（如果有）
                if server_name:
                    message += f"服务器: {server_name}\n"
                
                message += f"型号: {plan_code}\n"
                
                # 添加配置信息（如果有），使用与上架通知相同的树状格式
                if config_info:
                    message += (
                        f"配置: {config_info['display']}\n"
                        f"├─ 内存: {config_info['memory']}\n"
                        f"└─ 存储: {config_info['storage']}\n"
                    )
                
                message += f"\n数据中心: {datacenter}\n"
                message += f"状态: 已无货\n"
                message += f"⏰ 时间: {self._now_beijing().strftime('%Y-%m-%d %H:%M:%S')}"
                # 若可用，追加"从有货到无货历时多久"，格式与时间保持一致
                if duration_text:
                    # duration_text 格式为 "历时 xxx"，改为 "⏱️ 历时: xxx" 以保持样式一致
                    duration_display = duration_text.replace("历时 ", "⏱️ 历时: ")
                    message += f"\n{duration_display}"
            
            config_desc = f" [{config_info['display']}]" if config_info else ""
            self.add_log("INFO", f"正在发送Telegram通知: {plan_code}@{datacenter}{config_desc}", "monitor")
            result = self.send_notification(message)
            
            if result:
                self.add_log("INFO", f"✅ Telegram通知发送成功: {plan_code}@{datacenter}{config_desc} - {change_type}", "monitor")
            else:
                self.add_log("WARNING", f"⚠️ Telegram通知发送失败: {plan_code}@{datacenter}{config_desc}", "monitor")
            
        except Exception as e:
            self.add_log("ERROR", f"发送提醒时发生异常: {str(e)}", "monitor")
            self.add_log("ERROR", f"错误详情: {traceback.format_exc()}", "monitor")
    
    def _get_price_cache_key(self, plan_code, options):
        """
        生成价格缓存键
        
        Args:
            plan_code: 服务器型号
            options: 配置选项列表
        
        Returns:
            str: 缓存键
        """
        # 对options进行排序以确保相同配置生成相同键
        sorted_options = sorted(options) if options else []
        return f"{plan_code}|{','.join(sorted_options)}"
    
    def _get_cached_price(self, plan_code, options):
        """
        从缓存中获取价格
        
        Args:
            plan_code: 服务器型号
            options: 配置选项列表
        
        Returns:
            str or None: 缓存的价格文本，如果缓存不存在或过期返回None
        """
        cache_key = self._get_price_cache_key(plan_code, options)
        
        if cache_key in self.price_cache:
            cached_data = self.price_cache[cache_key]
            timestamp = cached_data.get("timestamp", 0)
            current_time = time.time()
            
            # 检查缓存是否过期
            if current_time - timestamp < self.price_cache_ttl:
                price_text = cached_data.get("price")
                age_hours = (current_time - timestamp) / 3600
                self.add_log("DEBUG", f"使用缓存价格（已缓存 {age_hours:.1f} 小时）: {price_text}", "monitor")
                return price_text
            else:
                # 缓存过期，删除
                del self.price_cache[cache_key]
                self.add_log("DEBUG", f"缓存已过期，删除: {cache_key}", "monitor")
        
        return None
    
    def _set_cached_price(self, plan_code, options, price_text):
        """
        将价格保存到缓存
        
        Args:
            plan_code: 服务器型号
            options: 配置选项列表
            price_text: 价格文本
        """
        cache_key = self._get_price_cache_key(plan_code, options)
        self.price_cache[cache_key] = {
            "price": price_text,
            "timestamp": time.time()
        }
        self.add_log("DEBUG", f"价格已缓存: {cache_key} = {price_text}", "monitor")
    
    def _get_price_info(self, plan_code, datacenter, config_info=None):
        """
        获取配置后的价格信息（带缓存支持）
        
        Args:
            plan_code: 服务器型号
            datacenter: 数据中心（用于查询，但不影响缓存键）
            config_info: 配置信息 {"memory": "xxx", "storage": "xxx", "display": "xxx", "options": [...]}
        
        Returns:
            str: 价格信息文本，如果获取失败返回None
        """
        try:
            # 提取配置选项
            options = []
            
            if config_info:
                # 如果config_info中已经有options字段（API2格式），直接使用
                if 'options' in config_info and config_info['options']:
                    options = config_info['options']
            
            # 先检查缓存
            cached_price = self._get_cached_price(plan_code, options)
            if cached_price:
                return cached_price
            
            # 缓存不存在或过期，查询新价格
            # 使用HTTP请求调用内部价格API（确保在正确的上下文访问配置）
            import requests
            
            self.add_log("DEBUG", f"开始获取价格: plan_code={plan_code}, datacenter={datacenter}, options={options}", "monitor")
            
            # 调用内部API端点
            api_url = "http://127.0.0.1:19998/api/internal/monitor/price"
            payload = {
                "plan_code": plan_code,
                "datacenter": datacenter,
                "options": options
            }
            
            try:
                response = requests.post(api_url, json=payload, timeout=30)
                response.raise_for_status()
                result = response.json()
            except requests.exceptions.RequestException as e:
                self.add_log("WARNING", f"价格API请求失败: {str(e)}", "monitor")
                return None
            
            if result.get("success") and result.get("price"):
                price_info = result["price"]
                prices = price_info.get("prices", {})
                with_tax = prices.get("withTax")
                currency = prices.get("currencyCode", "EUR")
                
                if with_tax is not None:
                    # 格式化价格
                    currency_symbol = "€" if currency == "EUR" else "$" if currency == "USD" else currency
                    price_text = f"{currency_symbol}{with_tax:.2f}/月"
                    self.add_log("DEBUG", f"价格获取成功: {price_text}", "monitor")
                    
                    # 保存到缓存
                    self._set_cached_price(plan_code, options, price_text)
                    
                    # 标记plan_code为有效（历史上有过价格查询成功）
                    self.valid_plan_codes.add(plan_code)
                    self.add_log("DEBUG", f"标记plan_code为有效: {plan_code}（历史上有过价格查询成功）", "monitor")
                    
                    return price_text
                else:
                    self.add_log("WARNING", f"价格获取成功但withTax为None: result={result}", "monitor")
            else:
                error_msg = result.get("error", "未知错误")
                self.add_log("WARNING", f"价格获取失败: {error_msg}", "monitor")
            
            return None
                
        except Exception as e:
            self.add_log("WARNING", f"获取价格信息时出错: {str(e)}", "monitor")
            import traceback
            self.add_log("WARNING", f"价格获取异常堆栈: {traceback.format_exc()}", "monitor")
            return None
    
    def check_new_servers(self, current_server_list):
        """
        检查新服务器上架
        
        Args:
            current_server_list: 当前服务器列表
        """
        try:
            current_codes = {s.get("planCode") for s in current_server_list if s.get("planCode")}
            
            # 首次运行，初始化已知服务器
            if not self.known_servers:
                self.known_servers = current_codes
                self.add_log("INFO", f"初始化已知服务器列表: {len(current_codes)} 台", "monitor")
                return
            
            # 找出新服务器
            new_servers = current_codes - self.known_servers
            
            if new_servers:
                for server_code in new_servers:
                    server = next((s for s in current_server_list if s.get("planCode") == server_code), None)
                    if server:
                        self.send_new_server_alert(server)
                
                # 更新已知服务器列表
                self.known_servers = current_codes
                self.add_log("INFO", f"检测到 {len(new_servers)} 台新服务器上架", "monitor")
        
        except Exception as e:
            self.add_log("ERROR", f"检查新服务器时出错: {str(e)}", "monitor")
    
    def send_new_server_alert(self, server):
        """发送新服务器上架提醒"""
        try:
            message = (
                f"🆕 新服务器上架通知！\n\n"
                f"型号: {server.get('planCode', 'N/A')}\n"
                f"名称: {server.get('name', 'N/A')}\n"
                f"CPU: {server.get('cpu', 'N/A')}\n"
                f"内存: {server.get('memory', 'N/A')}\n"
                f"存储: {server.get('storage', 'N/A')}\n"
                f"带宽: {server.get('bandwidth', 'N/A')}\n"
                f"时间: {self._now_beijing().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                f"💡 快去查看详情！"
            )
            
            self.send_notification(message)
            self.add_log("INFO", f"发送新服务器提醒: {server.get('planCode')}", "monitor")
            
        except Exception as e:
            self.add_log("ERROR", f"发送新服务器提醒失败: {str(e)}", "monitor")
    
    def monitor_loop(self):
        """监控主循环"""
        self.add_log("INFO", "监控循环已启动", "monitor")
        
        while self.running:
            try:
                # 检查订阅的服务器
                if self.subscriptions:
                    self.add_log("INFO", f"开始检查 {len(self.subscriptions)} 个订阅...", "monitor")
                    
                    for subscription in self.subscriptions:
                        if not self.running:  # 检查是否被停止
                            break
                        self.check_availability_change(subscription)
                        time.sleep(1)  # 避免请求过快
                else:
                    self.add_log("INFO", "当前无订阅，跳过检查", "monitor")
                
                # 注意：新服务器检查需要在外部调用时传入服务器列表
                
            except Exception as e:
                self.add_log("ERROR", f"监控循环出错: {str(e)}", "monitor")
                self.add_log("ERROR", f"错误详情: {traceback.format_exc()}", "monitor")
            
            # 等待下次检查（使用可中断的sleep）
            # 注意：每次循环都重新读取 check_interval，确保使用最新值
            if self.running:
                current_interval = self.check_interval  # 在循环开始前读取当前值
                self.add_log("INFO", f"等待 {current_interval} 秒后进行下次检查...", "monitor")
                # 分段sleep，每秒检查一次running状态，实现快速停止
                for _ in range(current_interval):
                    if not self.running:
                        break
                    time.sleep(1)
        
        self.add_log("INFO", "监控循环已停止", "monitor")
    
    def start(self):
        """启动监控"""
        if self.running:
            self.add_log("WARNING", "监控已在运行中", "monitor")
            return False
        
        self.running = True
        self.thread = threading.Thread(target=self.monitor_loop, daemon=True)
        self.thread.start()
        
        self.add_log("INFO", f"服务器监控已启动 (检查间隔: {self.check_interval}秒)", "monitor")
        return True
    
    def stop(self):
        """停止监控"""
        if not self.running:
            self.add_log("WARNING", "监控未运行", "monitor")
            return False
        
        self.running = False
        self.add_log("INFO", "正在停止服务器监控...", "monitor")
        
        # 等待线程结束（最多等待3秒，因为已优化为1秒检查一次）
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3)
        
        self.add_log("INFO", "服务器监控已停止", "monitor")
        return True
    
    def get_status(self):
        """获取监控状态"""
        return {
            "running": self.running,
            "subscriptions_count": len(self.subscriptions),
            "known_servers_count": len(self.known_servers),
            "check_interval": self.check_interval,
            "subscriptions": self.subscriptions
        }
    
    def set_check_interval(self, interval):
        """设置检查间隔（秒）- 已禁用，全局固定为5秒"""
        # 检查间隔全局固定为5秒，不允许修改
        self.check_interval = 5
        self.add_log("INFO", "检查间隔已全局固定为5秒，无法修改", "monitor")
        return True
