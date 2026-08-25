<?php

namespace Muni\Arcop\Tests\Fixtures;

use Illuminate\Database\Eloquent\Model;
use Muni\Shared\Privacidad\Ciclo\EtiquetaDeTitular;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\TitularDeDatos;

class BuscadorDeVecinos implements BuscaTitulares
{
    public function buscar(string $termino): array
    {
        return VecinoDePrueba::query()
            ->where(fn ($q) => $q->where('nombre', 'like', '%'.$termino.'%')
                ->orWhere('documento', 'like', '%'.$termino.'%'))
            ->get()
            ->mapWithKeys(fn (VecinoDePrueba $v): array => [
                $v->getKey() => (string) EtiquetaDeTitular::de($v),
            ])
            ->all();
    }

    public function encontrar(int|string $clave): (Model&TitularDeDatos)|null
    {
        return VecinoDePrueba::find($clave);
    }
}
