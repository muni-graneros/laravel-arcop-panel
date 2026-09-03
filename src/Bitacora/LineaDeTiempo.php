<?php

namespace Muni\Arcop\Bitacora;

use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\Schema;
use Muni\Shared\Privacidad\Modelos\EntradaBitacora;
use Muni\Shared\Privacidad\Modelos\Solicitud;

/**
 * Lo que le pasó a una solicitud, leído de la bitácora del módulo.
 *
 * Se filtra por `datos->solicitud_id` (o por `solicitud_ref`, ver abajo) y no
 * por el titular: la bitácora de una persona puede tener años de eventos de
 * otras finalidades, y esta pantalla tiene que mostrar el expediente de ESTE
 * caso. Además, un caso anonimizado pierde el titular pero conserva sus
 * entradas, y por acá se siguen viendo.
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
        // `privacidad_bitacora` es inmutable y solo crece: sin índice, cada
        // expediente abierto escanea todas las filas del sistema. La columna
        // generada `solicitud_ref` (migración publicable, ver
        // ArcopPanelServiceProvider) trae ese índice; mientras el adoptante no
        // la haya corrido, se sigue filtrando por la clave JSON como siempre.
        return Schema::hasColumn('privacidad_bitacora', 'solicitud_ref')
            ? $this->porColumnaIndexada($solicitud)
            : $this->porClaveJson($solicitud);
    }

    /** @return Collection<int, EntradaBitacora> */
    private function porColumnaIndexada(Solicitud $solicitud): Collection
    {
        return $this->ordenada(
            EntradaBitacora::query()
                ->where('sistema', (string) config('privacidad.sistema'))
                ->where('solicitud_ref', (string) $solicitud->getKey())
                ->get(),
        );
    }

    /** @return Collection<int, EntradaBitacora> */
    private function porClaveJson(Solicitud $solicitud): Collection
    {
        return $this->ordenada(
            EntradaBitacora::query()
                ->where('sistema', (string) config('privacidad.sistema'))
                ->where('datos->solicitud_id', $solicitud->getKey())
                ->get(),
        );
    }

    /**
     * El orden se aplica DESPUÉS del `get()` y no con `orderBy()` en la
     * consulta: `orderBy()` no es un método propio de
     * `Illuminate\Database\Eloquent\Builder` —lo reenvía por `@mixin` a
     * `Illuminate\Database\Query\Builder`—, y ese reenvío le hace perder a
     * PHPStan el tipo del modelo en toda la cadena. Son pocas filas por
     * expediente: ordenar en PHP no pesa, y mantiene el tipo exacto.
     *
     * @param  Collection<int, EntradaBitacora>  $entradas
     * @return Collection<int, EntradaBitacora>
     */
    private function ordenada(Collection $entradas): Collection
    {
        return $entradas->sortBy([
            ['ocurrido_en', 'asc'],
            ['id', 'asc'],
        ])->values();
    }
}
