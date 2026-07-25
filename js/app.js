// --- Database Helpers (IndexedDB for Large Files) ---
    const DB_NAME = 'ExpenseTrackerDB';
    const DB_VERSION = 1;

    function getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
                if (!db.objectStoreNames.contains('expenses')) db.createObjectStore('expenses', { keyPath: 'id' });
            };
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e.target.error);
        });
    }

    async function dbSaveMeta(metaData) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('metadata', 'readwrite');
            tx.objectStore('metadata').put(metaData, 'appState');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbGetMeta() {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('metadata', 'readonly');
            const req = tx.objectStore('metadata').get('appState');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbSaveExpense(expense) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('expenses', 'readwrite');
            tx.objectStore('expenses').put(expense);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbGetAllExpenses() {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('expenses', 'readonly');
            const req = tx.objectStore('expenses').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbDeleteExpense(id) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('expenses', 'readwrite');
            tx.objectStore('expenses').delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbClearAll() {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['metadata', 'expenses'], 'readwrite');
            tx.objectStore('metadata').clear();
            tx.objectStore('expenses').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // --- Application State ---
    let state = {
        userName: 'You',
        currency: '₹',
        participants: ['You'],
        categories: ['Food', 'Travel', 'Stay', 'Entertainment', 'Other'],
        currentSplitMethod: 'equal'
    };
    let expenses = []; 
    
    let dateChartInstance = null;
    let categoryChartInstance = null;
    let peopleChartInstance = null;
    let editingExpenseId = null;
    let stagedAttachments = []; 

    // --- Initialization & Migration ---
    async function init() {
        try {
            const oldData = localStorage.getItem('expenseTrackerData');
            if (oldData) {
                const parsed = JSON.parse(oldData);
                state.userName = parsed.userName || 'You';
                state.currency = parsed.currency || '₹';
                state.participants = parsed.participants || ['You'];
                state.categories = parsed.categories || ['Food', 'Travel', 'Stay', 'Other'];
                
                await dbSaveMeta(state);
                if (parsed.expenses) {
                    for (let exp of parsed.expenses) {
                        delete exp.subcategory; // cleanup old field
                        await dbSaveExpense(exp);
                    }
                }
                localStorage.removeItem('expenseTrackerData');
            } else {
                const meta = await dbGetMeta();
                if (meta) state = { ...state, ...meta };
            }

            expenses = await dbGetAllExpenses() || [];
            
            // Clean up subcategories from existing expenses
            expenses.forEach(e => { delete e.subcategory; });
            
            if (!state.participants.includes(state.userName)) {
                state.participants.unshift(state.userName);
            }

            updateCurrencyDisplay();
            switchView('dashboard');
            updateAllViews();
        } catch(e) {
            console.error("Initialization Error:", e);
        }
    }

    async function saveMetadataOnly() {
        await dbSaveMeta(state);
    }

    function formatMoney(amount) {
        return `${state.currency}${amount.toFixed(2)}`;
    }

    function updateCurrencyDisplay() {
        document.querySelectorAll('.currency-display').forEach(el => el.innerText = state.currency);
    }

    function updateFilters() {
        const catOptions = '<option value="all">Category: All</option>' + 
            state.categories.map(c => `<option value="${c}">${c}</option>`).join('');
            
        const personOptions = '<option value="all">Involved: All</option>' + 
            state.participants.map(p => `<option value="${p}">${p}</option>`).join('');
            
        const payerOptions = '<option value="all">Paid By: All</option>' + 
            state.participants.map(p => `<option value="${p}">${p}</option>`).join('');
            
        // Update both Dashboard and History filters
        ['dash', 'hist'].forEach(prefix => {
            const catSelect = document.getElementById(`${prefix}-filter-category`);
            const personSelect = document.getElementById(`${prefix}-filter-person`);
            const payerSelect = document.getElementById(`${prefix}-filter-payer`);
            
            const currCat = catSelect.value;
            const currPerson = personSelect.value;
            const currPayer = payerSelect.value;
            
            catSelect.innerHTML = catOptions;
            personSelect.innerHTML = personOptions;
            payerSelect.innerHTML = payerOptions;
            
            if (state.categories.includes(currCat) || currCat === 'all') catSelect.value = currCat;
            if (state.participants.includes(currPerson) || currPerson === 'all') personSelect.value = currPerson;
            if (state.participants.includes(currPayer) || currPayer === 'all') payerSelect.value = currPayer;
        });

        // Populate Timeline multi-select participant checkboxes
        const histContainer = document.getElementById('hist-filter-participant-checkboxes');
        if (histContainer) {
            const savedChecked = {};
            histContainer.querySelectorAll('.hist-filter-chk').forEach(chk => {
                savedChecked[chk.getAttribute('data-name')] = chk.checked;
            });
            
            histContainer.innerHTML = state.participants.map(p => {
                const isChecked = savedChecked[p] !== undefined ? savedChecked[p] : true;
                return `
                    <label class="inline-flex items-center gap-1.5 px-2 py-1 bg-indigo-50/50 border border-indigo-200 rounded-md text-xs font-medium text-indigo-900 cursor-pointer hover:bg-indigo-100 transition-colors select-none">
                        <input type="checkbox" data-name="${p}" ${isChecked ? 'checked' : ''} onchange="renderHistory()" class="hist-filter-chk w-3.5 h-3.5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500">
                        <span>${p}${p === state.userName ? ' (You)' : ''}</span>
                    </label>
                `;
            }).join('');
        }
    }

    function selectAllHistFilterParticipants(selectAll) {
        document.querySelectorAll('.hist-filter-chk').forEach(chk => chk.checked = selectAll);
        renderHistory();
    }

    function clearFilters(viewPrefix) {
        document.getElementById(`${viewPrefix}-filter-search`).value = '';
        document.getElementById(`${viewPrefix}-filter-person`).value = 'all';
        document.getElementById(`${viewPrefix}-filter-payer`).value = 'all';
        document.getElementById(`${viewPrefix}-filter-category`).value = 'all';
        document.getElementById(`${viewPrefix}-filter-month`).value = '';
        document.getElementById(`${viewPrefix}-filter-date`).value = '';
        
        if (viewPrefix === 'hist') {
            document.querySelectorAll('.hist-filter-chk').forEach(chk => chk.checked = true);
        }

        if (viewPrefix === 'dash') renderDashboard();
        if (viewPrefix === 'hist') renderHistory();
    }

    function applyFilters(expenseList, viewPrefix) {
        const filterSearch = document.getElementById(`${viewPrefix}-filter-search`).value.toLowerCase();
        const filterCat = document.getElementById(`${viewPrefix}-filter-category`).value;
        const filterPerson = document.getElementById(`${viewPrefix}-filter-person`).value;
        const filterPayer = document.getElementById(`${viewPrefix}-filter-payer`).value;
        const filterMonth = document.getElementById(`${viewPrefix}-filter-month`).value;
        const filterDate = document.getElementById(`${viewPrefix}-filter-date`).value;

        let checkedFilterPersons = null;
        if (viewPrefix === 'hist') {
            const chks = document.querySelectorAll('.hist-filter-chk:checked');
            const totalChks = document.querySelectorAll('.hist-filter-chk');
            if (totalChks.length > 0 && chks.length < totalChks.length) {
                checkedFilterPersons = Array.from(chks).map(c => c.getAttribute('data-name'));
            }
        }

        return expenseList.filter(exp => {
            // Search Match
            let matchSearch = !filterSearch || exp.description.toLowerCase().includes(filterSearch);

            // Category Match
            let matchCat = filterCat === 'all' || exp.category === filterCat;
            
            // Person filter logic: Shows if they are involved in the split or if they paid
            let matchPerson = filterPerson === 'all' || 
                              exp.paidBy === filterPerson || 
                              (exp.splits && exp.splits[filterPerson] !== undefined);
                              
            // Payer filter strictly checks who paid
            let matchPayer = filterPayer === 'all' || exp.paidBy === filterPayer;

            // Date & Month filtering
            let matchMonth = !filterMonth || exp.date.startsWith(filterMonth);
            let matchDate = !filterDate || exp.date.startsWith(filterDate);

            // Participant Filter Checkboxes
            let matchFilterPersons = true;
            if (checkedFilterPersons) {
                matchFilterPersons = checkedFilterPersons.some(p => exp.paidBy === p || (exp.splits && exp.splits[p] !== undefined && exp.splits[p] > 0));
            }

            return matchSearch && matchCat && matchPerson && matchPayer && matchMonth && matchDate && matchFilterPersons;
        });
    }

    // --- Navigation ---
    function switchView(viewName) {
        document.querySelectorAll('.view-section').forEach(el => el.classList.add('hide'));
        document.getElementById(`view-${viewName}`).classList.remove('hide');
        
        document.querySelectorAll('.bottom-nav button').forEach(el => {
            el.classList.remove('text-indigo-600');
            el.classList.add('text-gray-500');
        });
        
        if (viewName !== 'settings') {
            document.getElementById(`nav-${viewName}`).classList.remove('text-gray-500');
            document.getElementById(`nav-${viewName}`).classList.add('text-indigo-600');
        }

        if (viewName === 'dashboard') renderDashboard();
        if (viewName === 'history') renderHistory();
        if (viewName === 'people') renderPeople();
        if (viewName === 'settings') {
            document.getElementById('setting-user-name').value = state.userName;
            document.getElementById('setting-currency').value = state.currency;
        }
    }

    function updateAllViews() {
        updateFilters(); // Ensure all dropdowns are synchronized
        renderDashboard();
        renderHistory();
        renderPeople();
        updateCurrencyDisplay();
    }

    // --- Attachments Logic ---
    function handleFileSelect(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        document.getElementById('submit-text').classList.add('hide');
        document.getElementById('submit-loader').classList.remove('hide');
        document.getElementById('submit-btn').disabled = true;

        let processedCount = 0;
        
        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = function(e) {
                stagedAttachments.push({
                    name: file.name,
                    type: file.type,
                    data: e.target.result 
                });
                
                processedCount++;
                if (processedCount === files.length) {
                    renderAttachmentPreviews();
                    document.getElementById('submit-text').classList.remove('hide');
                    document.getElementById('submit-loader').classList.add('hide');
                    document.getElementById('submit-btn').disabled = false;
                    event.target.value = ''; 
                }
            };
            reader.readAsDataURL(file);
        });
    }

    function renderAttachmentPreviews() {
        const container = document.getElementById('attachment-previews');
        container.innerHTML = '';
        stagedAttachments.forEach((att, idx) => {
            const isImage = att.type.startsWith('image/');
            const iconHtml = isImage 
                ? `<img src="${att.data}" class="w-10 h-10 object-cover rounded">`
                : `<div class="w-10 h-10 bg-red-100 text-red-600 rounded flex items-center justify-center"><svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"></path></svg></div>`;
            
            container.innerHTML += `
                <div class="flex items-center justify-between bg-white border border-gray-200 p-2 rounded shadow-sm">
                    <div class="flex items-center gap-3 overflow-hidden">
                        ${iconHtml}
                        <span class="text-sm text-gray-700 truncate">${att.name}</span>
                    </div>
                    <button type="button" onclick="removeStagedAttachment(${idx})" class="text-red-500 hover:text-red-700 p-1">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
            `;
        });
    }

    function removeStagedAttachment(index) {
        stagedAttachments.splice(index, 1);
        renderAttachmentPreviews();
    }

    function openImageViewer(src, name) {
        const img = document.getElementById('image-viewer-img');
        const dl = document.getElementById('image-viewer-download');
        img.src = src;
        dl.href = src;
        dl.download = name || "expense_receipt.jpg";
        document.getElementById('image-viewer').classList.remove('hide');
    }

    function closeImageViewer() {
        document.getElementById('image-viewer').classList.add('hide');
        document.getElementById('image-viewer-img').src = '';
    }

    function downloadFile(dataUrl, fileName) {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- Add & Edit Expense Form Logic ---
    function openAddForm() {
        editingExpenseId = null;
        stagedAttachments = [];
        populateAddExpenseForm();
        renderAttachmentPreviews();
        document.getElementById('form-title').innerText = "Add New Expense";
        document.getElementById('submit-btn').querySelector('#submit-text').innerText = "Save Expense";
        document.getElementById('cancel-edit-btn').classList.add('hide');
        switchView('add');
    }

    function populateAddExpenseForm() {
        const payerSelect = document.getElementById('exp-payer');
        const catSelect = document.getElementById('exp-category');
        const dateInput = document.getElementById('exp-date');
        
        // Add default placeholders
        payerSelect.innerHTML = `<option value="" disabled selected>Select who paid</option>` + 
            state.participants.map(p => `<option value="${p}">${p}</option>`).join('');
            
        catSelect.innerHTML = `<option value="" disabled selected>Select category</option>` + 
            state.categories.map(c => `<option value="${c}">${c}</option>`).join('');
        
        document.getElementById('expense-form').reset();
        
        // Default to today
        dateInput.value = new Date().toISOString().split('T')[0];
        
        setSplitMethod('equal');
    }

    function addNewCategory() {
        const newCat = prompt("Enter new category name:");
        if (newCat && newCat.trim() !== '') {
            const formattedCat = newCat.trim();
            if (!state.categories.includes(formattedCat)) {
                state.categories.push(formattedCat);
                saveMetadataOnly();
                updateFilters(); 
                
                const catSelect = document.getElementById('exp-category');
                catSelect.innerHTML += `<option value="${formattedCat}">${formattedCat}</option>`;
                catSelect.value = formattedCat;
            }
        }
    }

    function editExpense(id) {
        const exp = expenses.find(e => e.id === id);
        if (!exp) return;

        editingExpenseId = id;
        stagedAttachments = exp.attachments ? JSON.parse(JSON.stringify(exp.attachments)) : [];
        
        const payerSelect = document.getElementById('exp-payer');
        const catSelect = document.getElementById('exp-category');
        
        payerSelect.innerHTML = `<option value="" disabled>Select who paid</option>` + 
            state.participants.map(p => `<option value="${p}">${p}</option>`).join('');
            
        catSelect.innerHTML = `<option value="" disabled>Select category</option>` + 
            state.categories.map(c => `<option value="${c}">${c}</option>`).join('');

        switchView('add');

        document.getElementById('form-title').innerText = "Edit Expense";
        document.getElementById('submit-btn').querySelector('#submit-text').innerText = "Update Expense";
        document.getElementById('cancel-edit-btn').classList.remove('hide');

        document.getElementById('exp-desc').value = exp.description;
        document.getElementById('exp-amount').value = exp.amount;
        document.getElementById('exp-category').value = exp.category;
        
        // Ensure Date is formatted for the input
        const dateObj = new Date(exp.date);
        document.getElementById('exp-date').value = dateObj.toISOString().split('T')[0];
        
        document.getElementById('exp-payer').value = exp.paidBy;

        setSplitMethod(exp.splitMethod);
        renderAttachmentPreviews();

        if (exp.splitMethod === 'equal') {
            document.querySelectorAll('.split-participant-check').forEach(chk => {
                chk.checked = !!exp.splits[chk.getAttribute('data-name')];
            });
        } else if (exp.splitMethod === 'exact') {
            document.querySelectorAll('.split-amount-input').forEach(inp => {
                const name = inp.getAttribute('data-name');
                inp.value = exp.splits[name] ? exp.splits[name].toFixed(2) : '';
            });
        } else if (exp.splitMethod === 'percentage') {
            document.querySelectorAll('.split-percent-input').forEach(inp => {
                const name = inp.getAttribute('data-name');
                if (exp.splits[name]) { inp.value = ((exp.splits[name] / exp.amount) * 100).toFixed(1); }
            });
        }
    }

    function setSplitMethod(method) {
        state.currentSplitMethod = method;
        
        ['equal', 'exact', 'percentage'].forEach(m => {
            const btn = document.getElementById(`btn-split-${m}`);
            if (m === method) {
                btn.className = "flex-1 py-1.5 rounded-md text-sm font-medium bg-white shadow-sm transition-all text-indigo-600";
            } else {
                btn.className = "flex-1 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-200 transition-all";
            }
        });

        const container = document.getElementById('split-details');
        container.innerHTML = '';
        
        state.participants.forEach(p => {
            let inputHtml = '';
            if (method === 'equal') {
                inputHtml = `<input type="checkbox" checked class="split-participant-check w-4 h-4 text-indigo-600" data-name="${p}">`;
            } else if (method === 'exact') {
                inputHtml = `
                    <div class="flex items-center gap-1">
                        <span class="text-gray-500 text-sm currency-display">${state.currency}</span>
                        <input type="number" min="0" step="0.01" placeholder="0.00" class="split-amount-input w-20 border rounded px-2 py-1 text-sm outline-none" data-name="${p}">
                    </div>`;
            } else if (method === 'percentage') {
                inputHtml = `
                    <div class="flex items-center gap-1">
                        <input type="number" min="0" max="100" step="0.1" placeholder="0" class="split-percent-input w-16 border rounded px-2 py-1 text-sm outline-none" data-name="${p}">
                        <span class="text-gray-500 text-sm">%</span>
                    </div>`;
            }

            container.innerHTML += `
                <div class="flex justify-between items-center bg-white p-2 rounded border border-gray-100">
                    <span class="text-sm font-medium text-gray-700">${p} ${p === state.userName ? '(You)' : ''}</span>
                    ${inputHtml}
                </div>
            `;
        });
    }

    document.getElementById('expense-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const desc = document.getElementById('exp-desc').value.trim();
        const amount = parseFloat(document.getElementById('exp-amount').value);
        const dateVal = document.getElementById('exp-date').value;
        const category = document.getElementById('exp-category').value;
        const payer = document.getElementById('exp-payer').value;
        const errorMsg = document.getElementById('split-error');
        
        errorMsg.classList.add('hide');

        if (!category) {
            errorMsg.innerText = "Please select a category.";
            errorMsg.classList.remove('hide');
            return;
        }

        if (!payer) {
            errorMsg.innerText = "Please select who paid the expense.";
            errorMsg.classList.remove('hide');
            return;
        }

        let splits = {};
        
        if (state.currentSplitMethod === 'equal') {
            const checks = document.querySelectorAll('.split-participant-check:checked');
            if (checks.length === 0) {
                errorMsg.innerText = "Select at least one person to split with."; errorMsg.classList.remove('hide'); return;
            }
            const splitAmount = amount / checks.length;
            checks.forEach(chk => { splits[chk.getAttribute('data-name')] = splitAmount; });
        } 
        else if (state.currentSplitMethod === 'exact') {
            let sum = 0;
            document.querySelectorAll('.split-amount-input').forEach(inp => {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) splits[inp.getAttribute('data-name')] = val;
                sum += val;
            });
            if (Math.abs(sum - amount) > 0.01) {
                errorMsg.innerText = `Amounts must sum up to ${formatMoney(amount)}. Current sum: ${formatMoney(sum)}`; errorMsg.classList.remove('hide'); return;
            }
        } 
        else if (state.currentSplitMethod === 'percentage') {
            let sum = 0;
            document.querySelectorAll('.split-percent-input').forEach(inp => {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) splits[inp.getAttribute('data-name')] = (val / 100) * amount;
                sum += val;
            });
            if (Math.abs(sum - 100) > 0.01) {
                errorMsg.innerText = `Percentages must sum up to 100%. Current sum: ${sum}%`; errorMsg.classList.remove('hide'); return;
            }
        }

        try {
            document.getElementById('submit-btn').disabled = true;
            
            // Create proper ISO date string from input
            const fullDateStr = new Date(dateVal).toISOString();

            let expenseObj = {
                id: editingExpenseId || Date.now(),
                date: fullDateStr,
                description: desc,
                amount: amount,
                category: category,
                paidBy: payer,
                splitMethod: state.currentSplitMethod,
                splits: splits,
                settled: false, // Default to not settled
                attachments: [...stagedAttachments]
            };

            // If editing, preserve the old settled status
            if (editingExpenseId) {
                const existing = expenses.find(e => e.id === editingExpenseId);
                if (existing && existing.settled) {
                    expenseObj.settled = true;
                }
            }

            await dbSaveExpense(expenseObj);

            if (editingExpenseId) {
                const idx = expenses.findIndex(e => e.id === editingExpenseId);
                if (idx !== -1) expenses[idx] = expenseObj;
            } else {
                expenses.push(expenseObj);
            }

            stagedAttachments = [];
            editingExpenseId = null;
            updateAllViews();
            switchView('history');
            
        } catch (err) {
            alert("Error saving expense: " + err.message);
        } finally {
            document.getElementById('submit-btn').disabled = false;
        }
    });

    // --- History & Timeline ---
    function renderHistory() {
        const list = document.getElementById('history-list');
        list.innerHTML = '';
        
        // Filter Data specifically for Timeline view
        const filteredExpenses = applyFilters(expenses, 'hist');

        if (filteredExpenses.length === 0) {
            list.innerHTML = `
                <div class="text-center py-10 bg-white rounded-xl border border-gray-200 shadow-sm mt-4">
                    <p class="text-gray-500">No expenses found matching the criteria.</p>
                </div>`;
            return;
        }

        // Sort by date (descending)
        const sortedExpenses = [...filteredExpenses].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Group by Date for Timeline
        const groupedExpenses = {};
        sortedExpenses.forEach(exp => {
            const dateObj = new Date(exp.date);
            // Ignore time portion for grouping by day
            const dateStr = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            if (!groupedExpenses[dateStr]) {
                groupedExpenses[dateStr] = [];
            }
            groupedExpenses[dateStr].push(exp);
        });

        // Render Timeline
        for (const [dateLabel, dayExpenses] of Object.entries(groupedExpenses)) {
            // Date Header
            list.innerHTML += `
                <div class="sticky top-0 z-10 bg-gray-100/90 backdrop-blur pt-4 pb-2 mt-2">
                    <h3 class="text-xs font-bold text-indigo-800 uppercase tracking-wider">${dateLabel}</h3>
                </div>
            `;

            // Expenses for that day
            dayExpenses.forEach(exp => {
                let attachmentsHtml = '';
                if (exp.attachments && exp.attachments.length > 0) {
                    attachmentsHtml = `<div class="mt-3 flex flex-col gap-2 pt-2 border-t border-gray-100">`;
                    exp.attachments.forEach((att) => {
                        const isImage = att.type.startsWith('image/');
                        if (isImage) {
                            attachmentsHtml += `
                            <div class="flex items-center justify-between bg-gray-50 p-2 rounded border border-gray-200">
                                <div class="flex items-center gap-2 cursor-pointer" onclick="openImageViewer('${att.data}', '${att.name}')">
                                    <img src="${att.data}" class="h-8 w-8 object-cover rounded shadow-sm">
                                    <span class="text-xs text-blue-600 truncate w-32">${att.name}</span>
                                </div>
                                <button onclick="downloadFile('${att.data}', '${att.name}')" class="text-xs bg-white border border-gray-300 px-2 py-1 rounded shadow-sm hover:bg-gray-100 flex items-center gap-1">
                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg> Save
                                </button>
                            </div>`;
                        } else {
                            attachmentsHtml += `
                            <div class="flex items-center justify-between bg-gray-50 p-2 rounded border border-gray-200">
                                <div class="flex items-center gap-2">
                                    <div class="w-8 h-8 bg-red-100 text-red-600 rounded flex items-center justify-center"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 100-2H7z" clip-rule="evenodd"></path></svg></div>
                                    <span class="text-xs text-gray-700 truncate w-32">${att.name}</span>
                                </div>
                                <button onclick="downloadFile('${att.data}', '${att.name}')" class="text-xs bg-white border border-gray-300 px-2 py-1 rounded shadow-sm hover:bg-gray-100 flex items-center gap-1">
                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg> Save
                                </button>
                            </div>`;
                        }
                    });
                    attachmentsHtml += `</div>`;
                }

                let splitCheckboxesHtml = '';
                if (state.participants && state.participants.length > 0) {
                    splitCheckboxesHtml = `
                        <div class="mt-3 pt-3 border-t border-gray-100 bg-gray-50/80 p-2.5 rounded-lg">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1">
                                    <svg class="w-3.5 h-3.5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                    Split Among:
                                </span>
                                <div class="space-x-1 text-[11px]">
                                    <button type="button" onclick="selectAllTimelineExpenseParticipants(${exp.id}, true)" class="text-indigo-600 font-semibold hover:underline">Select All</button>
                                    <span class="text-gray-300">|</span>
                                    <button type="button" onclick="selectAllTimelineExpenseParticipants(${exp.id}, false)" class="text-indigo-600 font-semibold hover:underline">Clear</button>
                                </div>
                            </div>
                            <div class="flex flex-wrap gap-1.5">
                    `;

                    state.participants.forEach(p => {
                        const isChecked = exp.splits && exp.splits[p] !== undefined && exp.splits[p] > 0;
                        const shareVal = isChecked ? exp.splits[p] : 0;
                        
                        splitCheckboxesHtml += `
                            <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer transition-all select-none ${isChecked ? 'bg-indigo-50 border-indigo-200 text-indigo-900 shadow-sm font-semibold' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-100'}">
                                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleTimelineParticipantSplit(${exp.id}, '${p}', this.checked)" class="w-3.5 h-3.5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer">
                                <span>${p}${p === state.userName ? ' (You)' : ''}</span>
                                ${isChecked ? `<span class="text-[11px] text-indigo-600 font-bold ml-0.5">${formatMoney(shareVal)}</span>` : ''}
                            </label>
                        `;
                    });

                    splitCheckboxesHtml += `
                            </div>
                        </div>
                    `;
                }

                const isSettled = !!exp.settled;

                list.innerHTML += `
                    <div class="bg-white p-4 rounded-xl border border-gray-200 shadow-sm relative ${isSettled ? 'opacity-70' : ''}">
                        <div class="absolute top-4 right-4 flex gap-2">
                            <button onclick="toggleSettled(${exp.id})" class="${isSettled ? 'text-emerald-500' : 'text-gray-300 hover:text-emerald-500'} transition-colors" title="${isSettled ? 'Mark Unsettled' : 'Mark Settled'}">
                                <svg class="w-6 h-6" fill="${isSettled ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                                    ${isSettled 
                                        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>' 
                                        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>'
                                    }
                                </svg>
                            </button>
                            <button onclick="editExpense(${exp.id})" class="text-gray-400 hover:text-indigo-600 transition-colors" title="Edit">
                                <svg class="w-5 h-5 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                            <button onclick="deleteExpenseDB(${exp.id})" class="text-gray-400 hover:text-red-500 transition-colors" title="Delete">
                                <svg class="w-5 h-5 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                        <div class="flex justify-between items-start pr-24">
                            <div class="w-full">
                                <h4 class="font-bold text-gray-800 text-lg ${isSettled ? 'line-through decoration-2 decoration-gray-300' : ''}">
                                    ${exp.description}
                                    ${isSettled ? '<span class="bg-emerald-100 text-emerald-700 text-[10px] px-2 py-0.5 rounded-full ml-2 align-middle uppercase tracking-wider font-semibold no-underline inline-block">Settled</span>' : ''}
                                </h4>
                                <p class="text-xs text-gray-500 mb-2 mt-1"><span class="bg-gray-100 px-2 py-0.5 rounded text-gray-600">${exp.category}</span></p>
                                <p class="text-sm text-gray-600"><span class="font-medium">${exp.paidBy === state.userName ? 'You' : exp.paidBy}</span> paid <span class="font-semibold text-indigo-600">${formatMoney(exp.amount)}</span></p>
                                ${attachmentsHtml}
                                ${splitCheckboxesHtml}
                            </div>
                        </div>
                    </div>
                `;
            });
        }
    }

    async function toggleTimelineParticipantSplit(expId, participantName, isChecked) {
        const exp = expenses.find(e => e.id === expId);
        if (!exp) return;

        if (!exp.splits) exp.splits = {};

        const currentlyChecked = state.participants.filter(p => {
            if (p === participantName) return isChecked;
            return exp.splits[p] !== undefined && exp.splits[p] > 0;
        });

        if (currentlyChecked.length === 0) {
            alert("At least one participant must be selected to split the bill.");
            renderHistory();
            return;
        }

        const newSplits = {};
        const share = exp.amount / currentlyChecked.length;
        currentlyChecked.forEach(p => {
            newSplits[p] = share;
        });

        exp.splits = newSplits;
        exp.splitMethod = 'equal';

        await dbSaveExpense(exp);
        updateAllViews();
    }

    async function selectAllTimelineExpenseParticipants(expId, selectAll) {
        const exp = expenses.find(e => e.id === expId);
        if (!exp) return;

        if (!selectAll) {
            alert("At least one participant must be selected for the bill split.");
            return;
        }

        const newSplits = {};
        const share = exp.amount / state.participants.length;
        state.participants.forEach(p => {
            newSplits[p] = share;
        });

        exp.splits = newSplits;
        exp.splitMethod = 'equal';

        await dbSaveExpense(exp);
        updateAllViews();
    }

    async function toggleSettled(id) {
        const exp = expenses.find(e => e.id === id);
        if (exp) {
            exp.settled = !exp.settled;
            await dbSaveExpense(exp);
            updateAllViews();
        }
    }

    async function deleteExpenseDB(id) {
        if (confirm("Are you sure you want to delete this expense?")) {
            await dbDeleteExpense(id);
            expenses = expenses.filter(e => e.id !== id);
            updateAllViews();
        }
    }

    // --- Analytics Transparency Toggle ---
    function toggleTransparency() {
        const box = document.getElementById('transparency-box');
        const btn = document.getElementById('btn-transparency');
        if (box.classList.contains('hide')) {
            box.classList.remove('hide');
            btn.innerText = "Hide Math";
        } else {
            box.classList.add('hide');
            btn.innerText = "Show Math";
        }
    }

    // --- Settings & Data Management ---
    async function saveUserName() {
        const newName = document.getElementById('setting-user-name').value.trim();
        if (!newName) return alert("Name cannot be empty");
        const oldName = state.userName;
        if (newName !== oldName) {
            if (state.participants.includes(newName)) return alert("Participant exists.");
            const pIndex = state.participants.indexOf(oldName);
            if (pIndex !== -1) state.participants[pIndex] = newName;
            
            for (let exp of expenses) {
                let changed = false;
                if (exp.paidBy === oldName) { exp.paidBy = newName; changed = true; }
                if (exp.splits[oldName] !== undefined) { 
                    exp.splits[newName] = exp.splits[oldName]; 
                    delete exp.splits[oldName]; 
                    changed = true; 
                }
                if (changed) await dbSaveExpense(exp);
            }
            state.userName = newName; 
            await saveMetadataOnly(); 
            updateAllViews(); 
            alert("Name updated!");
        }
    }

    async function saveCurrency() {
        const newCurrency = document.getElementById('setting-currency').value.trim();
        if (newCurrency) { state.currency = newCurrency; await saveMetadataOnly(); updateAllViews(); alert("Currency updated!"); }
    }

    async function clearAllData() {
        if (confirm("Are you SURE you want to erase all data?")) {
            await dbClearAll();
            expenses = []; 
            state.participants = [state.userName]; 
            await saveMetadataOnly(); 
            updateAllViews(); 
            alert("Data cleared.");
        }
    }

    function exportToCSV() {
        if (expenses.length === 0) return alert("No data to export!");
        // Added Settled Column
        let csvContent = "Date,Description,Category,Total Amount,Paid By,Split Method,Settled,AttachmentsCount";
        state.participants.forEach(p => { csvContent += `,"${p}'s Share"`; }); csvContent += "\n";
        expenses.forEach(exp => {
            const dateStr = new Date(exp.date).toLocaleDateString(); 
            const desc = `"${exp.description.replace(/"/g, '""')}"`;
            const attCount = exp.attachments ? exp.attachments.length : 0;
            const settledStr = exp.settled ? "Yes" : "No";
            let row = `${dateStr},${desc},${exp.category},${exp.amount},${exp.paidBy},${exp.splitMethod},${settledStr},${attCount}`;
            state.participants.forEach(p => { row += `,${(exp.splits[p] || 0).toFixed(2)}`; }); csvContent += row + "\n";
        });
        downloadFile(URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })), `ExpenseTracker_Spreadsheet_${new Date().toISOString().split('T')[0]}.csv`);
    }

    async function exportFullBackup() {
        if (expenses.length === 0) return alert("No data to export!");
        const backupObj = {
            appName: "SplitTrack_Backup",
            version: 2,
            meta: state,
            expenses: expenses
        };
        const blob = new Blob([JSON.stringify(backupObj)], { type: "application/json" });
        downloadFile(URL.createObjectURL(blob), `ExpenseTracker_FullBackup_${new Date().toISOString().split('T')[0]}.json`);
    }

    function parseCSVLine(text) {
        let ret = [''], i = 0, p = '', s = true;
        for (let l of text) { if ('"' === l) { if (s && l === p) ret[i] += l; s = !s; } else if (',' === l && s) l = ret[++i] = ''; else ret[i] += l; p = l; }
        return ret.map(x => x.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    }

    async function importData(event) {
        const file = event.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async function(e) {
            const text = e.target.result;
            
            if (file.name.endsWith('.json')) {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.appName === "SplitTrack_Backup" || parsed.expenses) {
                        await dbClearAll();
                        state = { ...state, ...parsed.meta };
                        await saveMetadataOnly();
                        expenses = [];
                        let count = 0;
                        for (let exp of parsed.expenses) {
                            delete exp.subcategory; // scrub incoming data
                            await dbSaveExpense(exp);
                            expenses.push(exp);
                            count++;
                        }
                        updateAllViews(); switchView('history'); 
                        alert(`Successfully restored full backup with ${count} expenses and all attachments!`);
                    } else throw new Error("Invalid backup file format");
                } catch(err) { alert("Error reading backup: " + err.message); }
            } 
            else if (file.name.endsWith('.csv')) {
                const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
                if (lines.length < 2) return alert("Invalid CSV.");
                try {
                    const header = parseCSVLine(lines[0]); 
                    if (header.length < 6) throw new Error("Missing columns");
                    
                    // Fallback to safely handle different CSV versions
                    let attCountIdx = header.indexOf("AttachmentsCount");
                    let settledIdx = header.indexOf("Settled");
                    
                    let partStartIndex = attCountIdx !== -1 ? attCountIdx + 1 : header.length; // fallback
                    if (attCountIdx === -1 && header[3] === "Subcategory") partStartIndex = 7; 
                    if (attCountIdx === -1 && header[3] !== "Subcategory") partStartIndex = 6;

                    const importedParticipants = [];
                    for (let i = partStartIndex; i < header.length; i++) { const match = header[i].match(/(.+)'s Share/); importedParticipants.push(match ? match[1] : header[i]); }
                    importedParticipants.forEach(p => { if (!state.participants.includes(p)) state.participants.push(p); });
                    
                    let importedCount = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const row = parseCSVLine(lines[i]); if (row.length < 6) continue;
                        
                        const cat = row[2]; if (!state.categories.includes(cat)) state.categories.push(cat);
                        
                        let hasSubcatColumn = header[3] === "Subcategory";
                        let amountIdx = hasSubcatColumn ? 4 : 3;
                        let paidByIdx = hasSubcatColumn ? 5 : 4;
                        let splitIdx = hasSubcatColumn ? 6 : 5;
                        
                        let isSettled = settledIdx !== -1 && row[settledIdx].toLowerCase() === 'yes';

                        let splits = {}, amount = parseFloat(row[amountIdx]);
                        for (let j = 0; j < importedParticipants.length; j++) {
                            const colIdx = partStartIndex + j; if (colIdx < row.length) { const val = parseFloat(row[colIdx]); if (!isNaN(val) && val > 0) splits[importedParticipants[j]] = val; }
                        }
                        
                        let expObj = { 
                            id: Date.now() + i, 
                            date: new Date(row[0]).toISOString(), 
                            description: row[1], 
                            category: cat, 
                            amount: isNaN(amount) ? 0 : amount, 
                            paidBy: row[paidByIdx], 
                            splitMethod: row[splitIdx] || 'equal', 
                            settled: isSettled,
                            splits: splits, 
                            attachments: [] 
                        };
                        await dbSaveExpense(expObj);
                        expenses.push(expObj);
                        importedCount++;
                    }
                    await saveMetadataOnly(); updateAllViews(); switchView('history'); alert(`Imported ${importedCount} expenses!`);
                } catch (err) { 
                    // Fallback: If CSV is an AI-extracted itemized bill format, route to AI Bill CSV import modal
                    openCSVImportModal(text);
                }
            }
            event.target.value = '';
        }; 
        reader.readAsText(file);
    }

    // --- AI Bill CSV Import Modal Logic ---
    const AI_BILL_PROMPT = `Extract all line items from the provided bill/receipt into a plain CSV format.
Use strictly these column headers: Date, Description, Category, Amount

Rules:
1. Date should be in YYYY-MM-DD format (use today's date if not specified on the bill).
2. Description should be the clean item name (e.g. "Chicken Burger", "Margherita Pizza").
3. Category should be "Food" (or "Travel", "Stay", "Entertainment", "Other" if applicable).
4. Amount should be a numeric decimal value without currency symbols (e.g. 15.50).
5. Do not include subtotal or total rows. Include only individual food/item lines.
6. Output ONLY the raw CSV block inside a code fence.`;

    let parsedModalItems = [];

    function openCSVImportModal(initialText = '') {
        const modal = document.getElementById('modal-csv-import');
        if (!modal) return;

        // Populate Payer dropdown
        const payerSelect = document.getElementById('modal-csv-payer');
        payerSelect.innerHTML = `<option value="" disabled selected>Select who paid this bill</option>` +
            state.participants.map(p => `<option value="${p}">${p} ${p === state.userName ? '(You)' : ''}</option>`).join('');

        // Populate Participants checklist
        const participantsContainer = document.getElementById('modal-csv-participants');
        participantsContainer.innerHTML = state.participants.map(p => `
            <label class="flex items-center justify-between p-1.5 rounded hover:bg-gray-50 cursor-pointer border border-gray-100">
                <span class="text-xs font-medium text-gray-700">${p} ${p === state.userName ? '(You)' : ''}</span>
                <input type="checkbox" checked value="${p}" class="modal-csv-part-check w-4 h-4 text-indigo-600 rounded">
            </label>
        `).join('');

        // Set initial CSV input if provided
        const inputArea = document.getElementById('csv-paste-input');
        if (typeof initialText === 'string' && initialText.trim()) {
            inputArea.value = initialText;
        }

        modal.classList.remove('hide');
        previewCSVBill();
    }

    function closeCSVImportModal() {
        const modal = document.getElementById('modal-csv-import');
        if (modal) modal.classList.add('hide');
    }

    function copyAIBillPrompt() {
        navigator.clipboard.writeText(AI_BILL_PROMPT).then(() => {
            const btn = document.getElementById('btn-copy-prompt');
            const origText = btn.innerHTML;
            btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> Copied!`;
            btn.classList.replace('bg-indigo-600', 'bg-emerald-600');
            setTimeout(() => {
                btn.innerHTML = origText;
                btn.classList.replace('bg-emerald-600', 'bg-indigo-600');
            }, 2000);
        }).catch(() => {
            alert("Copy failed. Prompt text:\n\n" + AI_BILL_PROMPT);
        });
    }

    function togglePromptPreview() {
        const box = document.getElementById('prompt-preview-box');
        const btn = document.getElementById('btn-toggle-prompt');
        if (box.classList.contains('hide')) {
            box.classList.remove('hide');
            btn.innerText = "Hide";
        } else {
            box.classList.add('hide');
            btn.innerText = "Show";
        }
    }

    function selectAllCSVParticipants(select) {
        document.querySelectorAll('.modal-csv-part-check').forEach(chk => {
            chk.checked = select;
        });
    }

    function handleModalCSVFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('csv-paste-input').value = e.target.result;
            previewCSVBill();
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    function parseAIBillCSV(text) {
        if (!text || !text.trim()) return [];
        
        let cleaned = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
        const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return [];

        let items = [];
        let startIndex = 0;
        
        const header = parseCSVLine(lines[0]);
        const isHeader = header.some(h => ['date', 'description', 'item', 'title', 'category', 'amount', 'cost', 'price'].includes(h.toLowerCase()));
        if (isHeader) {
            startIndex = 1;
        }

        const dateIdx = header.findIndex(h => h.toLowerCase().includes('date'));
        const descIdx = header.findIndex(h => h.toLowerCase().includes('desc') || h.toLowerCase().includes('item') || h.toLowerCase().includes('title'));
        const catIdx = header.findIndex(h => h.toLowerCase().includes('cat'));
        const amtIdx = header.findIndex(h => h.toLowerCase().includes('amount') || h.toLowerCase().includes('cost') || h.toLowerCase().includes('price'));

        const todayStr = new Date().toISOString().split('T')[0];

        for (let i = startIndex; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]);
            if (cols.length < 2) continue;

            let dateVal = todayStr;
            let descVal = '';
            let catVal = 'Food';
            let amtVal = 0;

            if (isHeader && amtIdx !== -1) {
                if (dateIdx !== -1 && cols[dateIdx]) dateVal = cols[dateIdx];
                if (descIdx !== -1 && cols[descIdx]) descVal = cols[descIdx];
                if (catIdx !== -1 && cols[catIdx]) catVal = cols[catIdx];
                if (cols[amtIdx]) amtVal = parseFloat(cols[amtIdx].replace(/[^0-9.]/g, '')) || 0;
            } else {
                if (cols.length >= 4) {
                    dateVal = cols[0] || todayStr;
                    descVal = cols[1] || 'Food Item';
                    catVal = cols[2] || 'Food';
                    amtVal = parseFloat(cols[3].replace(/[^0-9.]/g, '')) || 0;
                } else if (cols.length === 3) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(cols[0])) {
                        dateVal = cols[0];
                        descVal = cols[1];
                        amtVal = parseFloat(cols[2].replace(/[^0-9.]/g, '')) || 0;
                    } else {
                        descVal = cols[0];
                        catVal = cols[1];
                        amtVal = parseFloat(cols[2].replace(/[^0-9.]/g, '')) || 0;
                    }
                } else if (cols.length === 2) {
                    descVal = cols[0];
                    amtVal = parseFloat(cols[1].replace(/[^0-9.]/g, '')) || 0;
                }
            }

            if (isNaN(new Date(dateVal).getTime())) {
                dateVal = todayStr;
            } else {
                dateVal = new Date(dateVal).toISOString().split('T')[0];
            }

            if (!descVal) descVal = 'Food Item';
            if (!state.categories.includes(catVal)) {
                catVal = 'Food';
            }

            if (amtVal > 0) {
                items.push({
                    date: dateVal,
                    description: descVal,
                    category: catVal,
                    amount: amtVal
                });
            }
        }
        return items;
    }

    function previewCSVBill() {
        const text = document.getElementById('csv-paste-input').value;
        parsedModalItems = parseAIBillCSV(text);

        const container = document.getElementById('modal-csv-preview-container');
        const submitBtn = document.getElementById('btn-import-bill-submit');
        const totalSpan = document.getElementById('modal-csv-total');

        if (parsedModalItems.length === 0) {
            container.innerHTML = `<p class="text-xs text-gray-400 p-4 text-center">Paste CSV content above or upload a file to preview items.</p>`;
            submitBtn.disabled = true;
            totalSpan.innerText = `Total: ${state.currency}0.00`;
            return;
        }

        const totalAmount = parsedModalItems.reduce((sum, item) => sum + item.amount, 0);
        totalSpan.innerText = `Total: ${state.currency}${totalAmount.toFixed(2)} (${parsedModalItems.length} items)`;
        submitBtn.disabled = false;

        let tableHtml = `
            <table class="w-full text-xs text-left text-gray-600">
                <thead class="bg-gray-100 text-gray-700 uppercase text-[10px] font-bold sticky top-0">
                    <tr>
                        <th class="p-2">Date</th>
                        <th class="p-2">Item Description</th>
                        <th class="p-2">Category</th>
                        <th class="p-2 text-right">Amount</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 bg-white">
        `;

        parsedModalItems.forEach(item => {
            tableHtml += `
                <tr class="hover:bg-gray-50">
                    <td class="p-2 font-mono text-gray-500">${item.date}</td>
                    <td class="p-2 font-semibold text-gray-800">${item.description}</td>
                    <td class="p-2"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">${item.category}</span></td>
                    <td class="p-2 text-right font-mono font-bold text-indigo-600">${state.currency}${item.amount.toFixed(2)}</td>
                </tr>
            `;
        });

        tableHtml += `</tbody></table>`;
        container.innerHTML = tableHtml;
    }

    async function executeCSVBillImport() {
        const payerSelect = document.getElementById('modal-csv-payer');
        const payer = payerSelect.value;
        if (!payer) {
            return alert("Please select who paid the bill.");
        }

        const checkedBoxes = Array.from(document.querySelectorAll('.modal-csv-part-check:checked')).map(c => c.value);
        if (checkedBoxes.length === 0) {
            return alert("Please tick at least one participant who shared this bill.");
        }

        if (parsedModalItems.length === 0) {
            return alert("No valid items parsed from the CSV.");
        }

        try {
            document.getElementById('btn-import-bill-submit').disabled = true;

            let count = 0;
            const splitShare = 1 / checkedBoxes.length;

            for (let item of parsedModalItems) {
                let splits = {};
                checkedBoxes.forEach(p => {
                    splits[p] = item.amount * splitShare;
                });

                let expObj = {
                    id: Date.now() + count,
                    date: new Date(item.date).toISOString(),
                    description: item.description,
                    category: item.category,
                    amount: item.amount,
                    paidBy: payer,
                    splitMethod: 'equal',
                    settled: false,
                    splits: splits,
                    attachments: []
                };

                await dbSaveExpense(expObj);
                expenses.push(expObj);
                count++;
            }

            await saveMetadataOnly();
            updateAllViews();
            closeCSVImportModal();
            switchView('history');
            alert(`Successfully imported ${count} bill items split among ${checkedBoxes.length} participant(s)!`);

        } catch (err) {
            alert("Error importing bill items: " + err.message);
        } finally {
            document.getElementById('btn-import-bill-submit').disabled = false;
        }
    }

    // --- People & Analytics ---
    function renderPeople() {
        const list = document.getElementById('people-list'); list.innerHTML = '';
        state.participants.forEach((person, index) => {
            const isUser = person === state.userName;
            list.innerHTML += `<li class="flex justify-between items-center p-3 hover:bg-gray-50"><span class="font-medium text-gray-700">${person} ${isUser ? '<span class="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full ml-2">You</span>' : ''}</span><button onclick="removePerson(${index})" class="text-red-500 hover:text-red-700 p-1" ${isUser ? 'disabled style="opacity:0.2"' : ''}><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button></li>`;
        });
    }

    document.getElementById('add-person-form').addEventListener('submit', async (e) => {
        e.preventDefault(); const name = document.getElementById('new-person-name').value.trim();
        if (name && !state.participants.includes(name)) { state.participants.push(name); document.getElementById('new-person-name').value = ''; await saveMetadataOnly(); updateAllViews(); }
        else if (state.participants.includes(name)) alert('Exists!');
    });

    async function removePerson(index) {
        const personName = state.participants[index]; if (personName === state.userName) return;
        const isInvolved = expenses.some(exp => exp.paidBy === personName || exp.splits[personName]);
        if (isInvolved) return alert('Cannot remove person. Erase their expenses first.');
        state.participants.splice(index, 1); await saveMetadataOnly(); updateAllViews();
    }

    function renderDashboard() {
        // 1. Filter Data based on Dashboard Inputs
        const filteredExpenses = applyFilters(expenses, 'dash');

        // Total and Share calculations (Include Settled)
        const totalExp = filteredExpenses.reduce((sum, exp) => sum + exp.amount, 0); 
        document.getElementById('dash-total').innerText = formatMoney(totalExp);
        
        const personalShare = filteredExpenses.reduce((sum, exp) => sum + (exp.splits[state.userName] || 0), 0); 
        document.getElementById('dash-personal').innerText = formatMoney(personalShare);
        
        // 2. Balances calculations (EXCLUDE SETTLED)
        const unsettledExpenses = filteredExpenses.filter(e => !e.settled);
        const balances = {}; 
        state.participants.forEach(p => { balances[p] = 0; });
        
        unsettledExpenses.forEach(exp => {
            if (balances[exp.paidBy] !== undefined) balances[exp.paidBy] += exp.amount;
            for (const [person, share] of Object.entries(exp.splits)) { 
                if (balances[person] !== undefined) balances[person] -= share; 
            }
        });

        // Generate Transparency Box HTML
        let transparencyHtml = '<div class="space-y-2"><div class="flex items-center gap-2 border-b border-gray-200 pb-2"><svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg><strong>Net Balance = Total Paid &minus; Total Share</strong></div>';
        let hasUnsettledData = false;
        
        state.participants.forEach(p => {
            const paid = unsettledExpenses.filter(e => e.paidBy === p).reduce((sum, e) => sum + e.amount, 0);
            const share = unsettledExpenses.reduce((sum, e) => sum + (e.splits[p] || 0), 0);
            const bal = paid - share;
            
            if (paid > 0 || share > 0) {
                hasUnsettledData = true;
                const balColor = bal > 0.01 ? 'text-emerald-600' : (bal < -0.01 ? 'text-red-500' : 'text-gray-500');
                const balSign = bal > 0.01 ? '+' : '';
                transparencyHtml += `
                    <div class="flex justify-between items-center py-1 border-b border-gray-100 last:border-0">
                        <span class="font-medium text-gray-700">${p}</span>
                        <span class="text-gray-500 text-[11px] sm:text-xs">
                            Paid ${formatMoney(paid)} &minus; Share ${formatMoney(share)} = 
                            <span class="font-bold ${balColor} text-sm">${balSign}${formatMoney(bal)}</span>
                        </span>
                    </div>`;
            }
        });
        if (!hasUnsettledData) transparencyHtml += '<p class="text-gray-500 italic py-1">No active unsettled expenses.</p>';
        transparencyHtml += '</div>';
        document.getElementById('transparency-box').innerHTML = transparencyHtml;

        // Simplification Algorithm
        let debtors = [], creditors = [];
        for (const [person, balance] of Object.entries(balances)) { 
            if (balance < -0.01) debtors.push({ person, amount: Math.abs(balance) }); 
            else if (balance > 0.01) creditors.push({ person, amount: balance }); 
        }
        debtors.sort((a, b) => b.amount - a.amount); 
        creditors.sort((a, b) => b.amount - a.amount);
        
        const settlements = []; let i = 0, j = 0;
        while (i < debtors.length && j < creditors.length) {
            let debtor = debtors[i], creditor = creditors[j]; let amount = Math.min(debtor.amount, creditor.amount);
            let dName = debtor.person === state.userName ? 'You' : debtor.person, cName = creditor.person === state.userName ? 'You' : creditor.person;
            settlements.push(`${dName} owe${dName==='You'?'':'s'} ${cName} <span class="font-bold text-gray-800">${formatMoney(amount)}</span>`);
            debtor.amount -= amount; creditor.amount -= amount;
            if (debtor.amount < 0.01) i++; if (creditor.amount < 0.01) j++;
        }
        
        const balanceList = document.getElementById('balances-list');
        balanceList.innerHTML = settlements.length === 0 ? '<p class="text-emerald-600 text-sm font-medium flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> All balances are settled up!</p>' : settlements.map(s => `<div class="flex items-center gap-2 border-l-4 border-orange-400 pl-3 py-1 bg-orange-50 rounded-r"><span class="text-orange-700">➜</span> <span>${s}</span></div>`).join('');
        
        // Charts use ALL filtered data (including settled)
        renderDateChart(filteredExpenses);
        renderPeopleChart(filteredExpenses);
        renderCategoryChart(filteredExpenses);
    }
    
    function renderDateChart(chartData) {
        const ctx = document.getElementById('dateCategoryChart').getContext('2d');
        
        // 1. Group by Date and Category
        const dateMap = {}; 
        chartData.forEach(exp => {
            const dateObj = new Date(exp.date);
            const isoDate = dateObj.toISOString().split('T')[0];
            
            if (!dateMap[isoDate]) dateMap[isoDate] = {};
            if (!dateMap[isoDate][exp.category]) dateMap[isoDate][exp.category] = 0;
            dateMap[isoDate][exp.category] += exp.amount;
        });

        // 2. Sort dates chronologically for X-axis
        const sortedDates = Object.keys(dateMap).sort();
        const labels = sortedDates.map(d => {
            const dateObj = new Date(d);
            return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });

        // 3. Create datasets for each category
        const bgColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b', '#14b8a6', '#f43f5e'];
        const datasets = [];
        
        state.categories.forEach((cat, index) => {
            const dataForCat = sortedDates.map(d => dateMap[d][cat] || 0);
            // Only add the category dataset if it has data
            if (dataForCat.some(val => val > 0)) {
                datasets.push({
                    label: cat,
                    data: dataForCat,
                    backgroundColor: bgColors[index % bgColors.length],
                });
            }
        });

        if (dateChartInstance) dateChartInstance.destroy();

        if (labels.length === 0) {
            dateChartInstance = new Chart(ctx, { 
                type: 'bar', 
                data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] }, 
                options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } } 
            }); 
            return;
        }

        dateChartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true },
                    y: { stacked: true }
                },
                plugins: {
                    legend: { 
                        position: 'top', 
                        labels: { boxWidth: 12, font: { size: 11 } } 
                    },
                    tooltip: {
                        mode: 'index', 
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                // Skip showing 0 values in the tooltip
                                if (context.raw > 0) {
                                    return ` ${context.dataset.label}: ${state.currency}${context.raw.toFixed(2)}`;
                                }
                                return undefined; 
                            },
                            footer: function(tooltipItems) {
                                // Calculate total sum of the visible bars for the day
                                let total = tooltipItems.reduce((sum, item) => sum + item.raw, 0);
                                return `Total: ${state.currency}${total.toFixed(2)}`;
                            }
                        }
                    }
                }
            }
        });
    }

    function renderPeopleChart(chartData) {
        const ctx = document.getElementById('peopleChart').getContext('2d'); 
        const personTotals = {};
        chartData.forEach(exp => { 
            for (const [person, share] of Object.entries(exp.splits)) {
                personTotals[person] = (personTotals[person] || 0) + share;
            }
        });
        
        const labels = Object.keys(personTotals); 
        const data = Object.values(personTotals); 
        const bgColors = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'];
        
        if (peopleChartInstance) peopleChartInstance.destroy();
        if (labels.length === 0) { 
            peopleChartInstance = new Chart(ctx, { type: 'pie', data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } } }); 
            return; 
        }
        
        peopleChartInstance = new Chart(ctx, { 
            type: 'pie', 
            data: { labels: labels.map(l => l === state.userName ? 'You' : l), datasets: [{ data: data, backgroundColor: bgColors.slice(0, labels.length), borderWidth: 1 }] }, 
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: function(context) { return ` ${state.currency}${context.raw.toFixed(2)}`; } } } } } 
        });
    }

    function renderCategoryChart(chartData) {
        const ctx = document.getElementById('categoryChart').getContext('2d'); const catTotals = {};
        chartData.forEach(exp => { catTotals[exp.category] = (catTotals[exp.category] || 0) + exp.amount; });
        const labels = Object.keys(catTotals), data = Object.values(catTotals), bgColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];
        if (categoryChartInstance) categoryChartInstance.destroy();
        if (labels.length === 0) { categoryChartInstance = new Chart(ctx, { type: 'doughnut', data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } } }); return; }
        categoryChartInstance = new Chart(ctx, { type: 'doughnut', data: { labels: labels, datasets: [{ data: data, backgroundColor: bgColors.slice(0, labels.length), borderWidth: 1 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: function(context) { return ` ${state.currency}${context.raw.toFixed(2)}`; } } } } } });
    }

    window.onload = init;
