<?php

namespace Muni\Arcop\Bitacora;

use Illuminate\Support\Collection;
use Muni\Shared\Privacidad\Modelos\EntradaBitacora;
use Muni\Shared\Privacidad\Modelos\Solicitud;

/**
 * Lo que le pasó a una solicitud, leído de la bitácora del módulo.
 *
 * Se filtra por `datos->solicitud_id` y no por el titular: la bitácora de una
 * persona puede tener años de eventos de otras finalidades, y esta pantalla
 * tiene que mostrar el expediente de ESTE caso. Además, un caso anonimizado
 * pierde el titular pero conserva sus entradas, y por acá se siguen viendo.
 *
 * Es de solo lectura, y no por comodidad: la bitácora del módulo es evidencia
 * con guardias de inmutabilidad en la base de datos. Un panel que la editara
 * destruiría lo único que prueba que el municipio atendió al vecino.
 */
final class LineaDeTiempo
{
    /** @return Collection<int, EntradaBitacora> */
    public function de(Solicitud $solicitud): Collection
    {
        return EntradaBitacora::query()
            ->where('sistema', (string) config('privacidad.sistema'))
            ->where('datos->solicitud_id', $solicitud->getKey())
            ->orderBy('ocurrido_en')
            ->orderBy('id')
            ->get();
    }
}
