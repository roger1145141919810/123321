const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};
let roomTimers = {};

io.on('connection', (socket) => {
    // 【加入房間】
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) rooms[roomId] = { 
            hostId: socket.id, 
            players: [], 
            status: 'waiting', 
            skipVotes: new Set(),
            nightAction: { killedId: null, savedId: null, poisonedId: null }
        };
        const room = rooms[roomId];

        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // --- 角色互動事件 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night') {
            room.nightAction.killedId = targetId;
            socket.emit('receiveMessage', { name: "系統", text: "🐺 你已選擇擊殺目標。", isSystem: true });
        }
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night' && player?.role === '預言家') {
            const target = room.players.find(p => p.id === targetId);
            const side = target?.role === '狼人' ? '壞人 (狼人)' : '好人';
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
        }
    });

    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night') {
            if (type === 'save') room.nightAction.savedId = targetId;
            if (type === 'poison') room.nightAction.poisonedId = targetId;
            socket.emit('receiveMessage', { name: "系統", text: "🧪 藥水已使用。", isSystem: true });
        }
    });

    // 【晝夜輪迴核心】
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        room.status = 'night';
        room.nightAction = { killedId: null, savedId: null, poisonedId: null };
        
        // 1. 通知所有人進入黑夜，隱藏投票按鈕，顯示角色面板
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼...", isSystem: true });

        let nightLeft = 30;
        io.to(roomId).emit('timerUpdate', nightLeft);
        roomTimers[roomId] = setInterval(() => {
            nightLeft--;
            io.to(roomId).emit('timerUpdate', nightLeft);
            if (nightLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                settleNight(roomId);
            }
        }, 1000);
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        let deadIds = [];
        const { killedId, savedId, poisonedId } = room.nightAction;
        if (killedId && killedId !== savedId) deadIds.push(killedId);
        if (poisonedId) deadIds.push(poisonedId);

        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        
        const deadNames = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name);
        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `🌅 天亮了！${deadNames.length > 0 ? "昨晚死亡的是：" + deadNames.join(', ') : "昨晚是個平安夜。"}`, 
            isSystem: true 
        });

        if (!checkGameOver(roomId)) {
            // 自動開啟白天計時，達成輪迴
            startDay(roomId);
        }
    }

    function startDay(roomId) {
        const room = rooms[roomId];
        room.status = 'day';
        room.skipVotes = new Set();
        
        // 2. 通知所有人進入白天，顯示投票按鈕
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        let timeLeft = 300;
        io.to(roomId).emit('timerUpdate', timeLeft);
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) triggerNight(roomId);
        }, 1000);
    }

    // 【按鈕控制：跳過投票】
    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status !== 'day') return;

        room.skipVotes.add(socket.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const required = Math.max(1, aliveCount - 1);

        io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⏭️ ${socket.username} 投票跳過 (${room.skipVotes.size}/${required})`, isSystem: true });

        if (room.skipVotes.size >= required) {
            triggerNight(socket.roomId);
        }
    });

    // 【遊戲開始】
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '❌ 人數不足。');
        
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民', '獵人'];
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i % rolesPool.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    // ... (其餘 disconnect, checkGameOver, endGame 邏輯保持不變) ...
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
            if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            delete rooms[roomId];
            delete roomTimers[roomId];
        } else {
            io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        }
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');
        if (wolves.length === 0) { endGame(roomId, "好人陣營"); return true; }
        if (humans.length === 0) { endGame(roomId, "狼人陣營"); return true; }
        return false;
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
    }
});

server.listen(process.env.PORT || 3000);
