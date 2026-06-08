package com.example.inventory;

import com.example.inventory.dto.ReserveRequest;
import com.example.inventory.dto.ReserveResponse;
import com.example.inventory.exception.InsufficientStockException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * InventoryController — 库存内部 HTTP 接口，供 order-service 等内部服务调用。
 * 路径前缀 /internal/inventory 仅内网可达，网关层不对外暴露。
 */
@RestController
@RequestMapping("/internal/inventory")
public class InventoryController {

    private static final Logger log = LoggerFactory.getLogger(InventoryController.class);

    private final InventoryService inventoryService;

    public InventoryController(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }

    /**
     * GET /internal/inventory/available?skuId={skuId}
     * 查询指定 SKU 的当前可用库存数量。
     */
    @GetMapping("/available")
    public ResponseEntity<Integer> getAvailable(@RequestParam String skuId) {
        int available = inventoryService.getAvailable(skuId);
        return ResponseEntity.ok(available);
    }

    /**
     * POST /internal/inventory/reserve
     * 预占库存。异常由全局 ExceptionHandler 统一处理，返回 4xx/5xx。
     *
     * 调用链：order-service → POST /internal/inventory/reserve → InventoryService.reserve()
     * 此处是 NPE 异常的传播路径起点（第 42 行 inventoryService.reserve 抛出后被捕获并向上传递）。
     */
    @PostMapping("/reserve")
    public ResponseEntity<ReserveResponse> reserve(@RequestBody ReserveRequest request) {  // line 42
        log.info("Reserve request: skuId={}, quantity={}, requestId={}",
                request.getSkuId(), request.getQuantity(), request.getRequestId());

        boolean success = inventoryService.reserve(
                request.getSkuId(),
                request.getQuantity(),
                request.getRequestId()
        );

        if (!success) {
            return ResponseEntity.internalServerError()
                    .body(new ReserveResponse(false, "reserve failed"));
        }
        return ResponseEntity.ok(new ReserveResponse(true, "ok"));
    }

    /**
     * POST /internal/inventory/release
     * 释放已预占库存，用于订单取消或支付超时场景。
     */
    @PostMapping("/release")
    public ResponseEntity<Void> release(@RequestBody ReserveRequest request) {
        inventoryService.release(
                request.getSkuId(),
                request.getQuantity(),
                request.getRequestId()
        );
        return ResponseEntity.ok().build();
    }
}
