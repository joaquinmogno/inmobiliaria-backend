const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const API_URL = 'http://localhost:3000/api';

async function main() {
    try {
        // 1. Login
        console.log('Logging in...');
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: 'admin@lavalle.com',
            password: 'admin123'
        });
        const token = loginRes.data.token;
        console.log('Login successful. Token obtained.');

        const headers = { Authorization: `Bearer ${token}` };

        // 2. Create Owner
        console.log('Creating Owner...');
        const ownerRes = await axios.post(`${API_URL}/propietarios`, {
            nombreCompleto: 'Juan Perez',
            telefono: '123456789',
            email: 'juan@example.com'
        }, { headers });
        const ownerId = ownerRes.data.id;
        console.log('Owner created:', ownerId);

        // 3. Create Property
        console.log('Creating Property...');
        const propRes = await axios.post(`${API_URL}/propiedades`, {
            direccion: 'Calle Falsa 123',
            piso: '1',
            departamento: 'A',
            propietarioId: ownerId
        }, { headers });
        const propId = propRes.data.id;
        console.log('Property created:', propId);

        // 4. Create Tenant
        console.log('Creating Tenant...');
        const tenantRes = await axios.post(`${API_URL}/inquilinos`, {
            nombreCompleto: 'Maria Garcia',
            telefono: '987654321',
            email: 'maria@example.com'
        }, { headers });
        const tenantId = tenantRes.data.id;
        console.log('Tenant created:', tenantId);

        // 5. Create Contract with PDF
        console.log('Creating Contract with PDF...');
        const form = new FormData();
        form.append('fechaInicio', '2024-01-01');
        form.append('fechaFin', '2026-01-01');
        form.append('observaciones', 'Contrato de prueba');
        form.append('propiedadId', propId);
        form.append('propietarioId', ownerId);
        form.append('inquilinoId', tenantId);
        form.append('pdf', fs.createReadStream('dummy.pdf'));

        const contractRes = await axios.post(`${API_URL}/contratos`, form, {
            headers: {
                ...headers,
                ...form.getHeaders()
            }
        });
        const contractId = contractRes.data.id;
        console.log('Contract created:', contractId);

        // 6. List Contracts
        console.log('Listing Contracts...');
        const listRes = await axios.get(`${API_URL}/contratos`, { headers });
        console.log('Contracts found:', listRes.data.length);
        console.log('First contract PDF path:', listRes.data[0].rutaPdf);

    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

main();
