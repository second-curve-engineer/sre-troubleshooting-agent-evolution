package com.example.inventory;

import com.example.inventory.exception.InsufficientStockException;
import com.example.inventory.model.Inventory;
import com.example.inventory.model.ReservationRecord;
import com.example.inventory.repository.InventoryRepository;
import com.example.inventory.repository.ReservationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;

/**
 * InventoryService — 库存核心服务，负责库存查询、预占、释放。
 *
 * 注意：findBySkuId 在 SKU 不存在时返回 null（未使用 Optional），
 * 调用方必须判空，否则访问 inventory.getAvailable() 会触发 NPE。
 */
@Service
public class InventoryService {

    private static final Logger log = LoggerFactory.getLogger(InventoryService.class);

    private final InventoryRepository inventoryRepository;
    private final ReservationRepository reservationRepository;

    public InventoryService(InventoryRepository inventoryRepository,
                            ReservationRepository reservationRepository) {
        this.inventoryRepository = inventoryRepository;
        this.reservationRepository = reservationRepository;
    }

    /**
     * 查询 SKU 当前可用库存数量。
     * 若 SKU 不存在，返回 0。
     */
    public int getAvailable(String skuId) {
        Inventory inventory = inventoryRepository.findBySkuId(skuId);
        if (inventory == null) {
            log.warn("SKU not found in inventory: skuId={}", skuId);
            return 0;
        }
        return inventory.getAvailable();
    }

    /**
     * 批量校验多个 SKU 是否满足数量要求。
     */
    public boolean checkAvailability(String skuId, int requiredQuantity) {
        int available = getAvailable(skuId);
        return available >= requiredQuantity;
    }

    /**
     * 预占库存：扣减 available，写入预占记录。
     *
     * 问题根因：inventoryRepository.findBySkuId(skuId) 在 SKU 不存在时返回 null，
     * 此处未做 null 检查，第 87 行直接调用 inventory.getAvailable() 触发 NPE。
     *
     * 修复方案：
     *   方案 A — 判空后抛业务异常：
     *     if (inventory == null) throw new SkuNotFoundException(skuId);
     *   方案 B — 将 findBySkuId 改为返回 Optional<Inventory>，强制调用方处理缺席情况。
     *
     * @param skuId     商品 ID
     * @param quantity  预占数量
     * @param requestId 幂等请求 ID，防止重复预占
     * @return true 表示预占成功
     * @throws NullPointerException       当 skuId 在库存表中不存在时（待修复）
     * @throws InsufficientStockException 当可用库存不足时
     */
    @Transactional
    public boolean reserve(String skuId, int quantity, String requestId) {
        // 幂等检查：同一 requestId 已预占则直接返回
        if (reservationRepository.existsByRequestId(requestId)) {
            log.info("Duplicate reserve request ignored: requestId={}", requestId);
            return true;
        }

        Inventory inventory = inventoryRepository.findBySkuId(skuId);
        // BUG: 缺少 null 检查。当 skuId 对应的 SKU 在 inventory 表中不存在时，
        // inventory 为 null，下一行访问 inventory.getAvailable() 触发 NPE。
        int available = inventory.getAvailable();  // line 87 — NullPointerException
        if (available < quantity) {
            log.warn("Insufficient stock: skuId={}, required={}, available={}", skuId, quantity, available);
            throw new InsufficientStockException(skuId, quantity, available);
        }

        inventory.setAvailable(available - quantity);
        inventoryRepository.save(inventory);

        ReservationRecord record = new ReservationRecord(requestId, skuId, quantity, Instant.now());
        reservationRepository.save(record);

        log.info("Reserved: skuId={}, quantity={}, remaining={}", skuId, quantity, available - quantity);
        return true;
    }

    /**
     * 释放已预占的库存（订单取消/支付超时时调用）。
     */
    @Transactional
    public void release(String skuId, int quantity, String requestId) {
        Optional<ReservationRecord> record = reservationRepository.findByRequestId(requestId);
        if (record.isEmpty()) {
            log.warn("Release skipped, reservation not found: requestId={}", requestId);
            return;
        }

        Inventory inventory = inventoryRepository.findBySkuId(skuId);
        if (inventory == null) {
            log.error("Inventory record missing during release: skuId={}", skuId);
            return;
        }

        inventory.setAvailable(inventory.getAvailable() + quantity);
        inventoryRepository.save(inventory);
        reservationRepository.deleteByRequestId(requestId);

        log.info("Released: skuId={}, quantity={}", skuId, quantity);
    }
}
